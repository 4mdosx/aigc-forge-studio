import type { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { RunnerError } from '../errors.ts'
import { DEFAULT_DICE_FIELDS, transaction } from '../db.ts'
import { joinPrompt, readRollConfig } from '../rollConfig.ts'
import { createTask, storedPaths } from '../task/records.ts'
import type { Runner } from '../task/queue.ts'
import { jsonObject } from './request.ts'

// dice 掷骰工作台：prompt 模版字段池存 SQLite（dice_fields 表，tiers JSON 列）。
// 每字段分层：common（手动公共池）+ general/sensitive/questionable/explicit（tag 分类导入），
// 每层独立 values（逗号分隔）与 count（摇几个）。
// GET 全量按 position 排序；PUT 全量替换（事务内 delete+insert）；reset 重种默认集。

export const TIER_KEYS = [
  'common',
  'general',
  'sensitive',
  'questionable',
  'explicit',
] as const

interface TierInput {
  values: string
  min: number
  max: number
}

// 每层取值数量是区间 [min, max]，掷骰时在区间内随机；旧版单值 count → min=max=count
function parseTiers(raw: unknown, fieldName: string): Record<string, TierInput> {
  if (raw === null || raw === undefined) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RunnerError(`field ${fieldName}: tiers must be an object`)
  }
  const out: Record<string, TierInput> = {}
  for (const [tier, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(TIER_KEYS as readonly string[]).includes(tier)) {
      throw new RunnerError(`field ${fieldName}: unknown tier "${tier}"`)
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new RunnerError(`field ${fieldName}: tier ${tier} must be an object`)
    }
    const t = value as Record<string, unknown>
    const values = typeof t.values === 'string' ? t.values : ''
    const min = Number(t.min ?? t.count ?? 1)
    const max = Number(t.max ?? t.count ?? 1)
    if (!Number.isInteger(min) || min < 0 || min > 99) {
      throw new RunnerError(`field ${fieldName}: tier ${tier} min must be an integer 0..99`)
    }
    if (!Number.isInteger(max) || max < 0 || max > 99) {
      throw new RunnerError(`field ${fieldName}: tier ${tier} max must be an integer 0..99`)
    }
    if (max < min) {
      throw new RunnerError(`field ${fieldName}: tier ${tier} max must be >= min`)
    }
    out[tier] = { values, min, max }
  }
  return out
}

interface DiceFieldInput {
  name: string
  tiers: Record<string, TierInput>
}

function parseFields(raw: unknown): DiceFieldInput[] {
  if (!Array.isArray(raw)) throw new RunnerError('fields must be an array')
  const seen = new Set<string>()
  const rows: DiceFieldInput[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new RunnerError('each field must be an object')
    }
    const body = item as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name === '') throw new RunnerError('field name is required')
    if (name.length > 64) throw new RunnerError('field name too long (max 64)')
    if (seen.has(name)) throw new RunnerError(`duplicate field name: ${name}`)
    seen.add(name)
    rows.push({ name, tiers: parseTiers(body.tiers, name) })
  }
  return rows
}

function insertRows(
  runner: Runner,
  rows: Array<{ name: string; tiers: unknown }>,
): void {
  const insert = runner.db.prepare(
    'INSERT INTO dice_fields (name, tiers, position) VALUES (?, ?, ?)',
  )
  for (const [index, row] of rows.entries()) {
    insert.run(row.name, JSON.stringify(row.tiers ?? {}), index)
  }
}

export function mountDice(app: Hono, runner: Runner): void {
  app.get('/dice/fields', (c) => {
    const rows = runner.db
      .prepare('SELECT name, tiers, position FROM dice_fields ORDER BY position, id')
      .all() as Array<{ name: string; tiers: string; position: number }>
    return c.json({
      fields: rows.map((row) => {
        let tiers: unknown = {}
        try {
          tiers = JSON.parse(row.tiers)
        } catch {
          tiers = {}
        }
        return { name: row.name, position: row.position, tiers }
      }),
    })
  })

  // 重置为种子默认集：清空后按 DEFAULT_DICE_FIELDS 重建（默认集只占 common 层）
  app.post('/dice/reset', (c) => {
    transaction(runner.db, () => {
      runner.db.prepare('DELETE FROM dice_fields').run()
      insertRows(
        runner,
        DEFAULT_DICE_FIELDS.map((field) => ({
          name: field.name,
          tiers: { common: { values: field.values, count: field.count } },
        })),
      )
    })
    return c.json({ reset: DEFAULT_DICE_FIELDS.length })
  })

  app.put('/dice/fields', async (c) => {
    const body = await jsonObject(c.req)
    const rows = parseFields(body.fields)
    transaction(runner.db, () => {
      runner.db.prepare('DELETE FROM dice_fields').run()
      insertRows(runner, rows)
    })
    return c.json({ saved: rows.length })
  })

  // 灵感表：每次「一起生成」落一条（pose + 结构化字段 + 拼合 prompt）
  app.post('/dice/rolls', async (c) => {
    const body = await jsonObject(c.req)
    const fieldsJson = body.fields
    if (!fieldsJson || typeof fieldsJson !== 'object' || Array.isArray(fieldsJson)) {
      throw new RunnerError('fields must be an object')
    }
    const prompt = typeof body.prompt === 'string' ? body.prompt : ''
    const negative = typeof body.negative === 'string' ? body.negative : null
    const poseName = typeof body.poseName === 'string' ? body.poseName : null
    const poseId = typeof body.poseId === 'string' ? body.poseId : null
    const id = randomUUID()
    runner.db
      .prepare(
        `INSERT INTO dice_rolls (id, pose_name, pose_id, fields_json, prompt, negative, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        poseName,
        poseId,
        JSON.stringify(fieldsJson),
        prompt,
        negative,
        runner.now().toISOString(),
      )
    return c.json({ id }, 201)
  })

  app.get('/dice/rolls', (c) => {
    const limitRaw = Number(c.req.query('limit') ?? '50')
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50
    const offsetRaw = Number(c.req.query('offset') ?? '0')
    const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0
    const total = (
      runner.db.prepare('SELECT COUNT(*) AS n FROM dice_rolls').get() as { n: number }
    ).n
    const rows = runner.db
      .prepare(
        `SELECT id, pose_name, pose_id, fields_json, prompt, negative, created_at
         FROM dice_rolls ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Array<{
      id: string
      pose_name: string | null
      pose_id: string | null
      fields_json: string
      prompt: string
      negative: string | null
      created_at: string
    }>
    return c.json({
      total,
      rolls: rows.map((row) => {
        let fields: unknown = {}
        try {
          fields = JSON.parse(row.fields_json)
        } catch {
          fields = {}
        }
        return {
          id: row.id,
          poseName: row.pose_name,
          poseId: row.pose_id,
          fields,
          prompt: row.prompt,
          negative: row.negative,
          createdAt: row.created_at,
        }
      }),
    })
  })

  app.get('/dice/rolls/:id', (c) => {
    const row = runner.db
      .prepare(
        `SELECT id, pose_name, pose_id, fields_json, prompt, negative, created_at
         FROM dice_rolls WHERE id = ?`,
      )
      .get(c.req.param('id')) as
      | {
          id: string
          pose_name: string | null
          pose_id: string | null
          fields_json: string
          prompt: string
          negative: string | null
          created_at: string
        }
      | undefined
    if (!row) throw new RunnerError('roll not found', 404)
    let fields: unknown = {}
    try {
      fields = JSON.parse(row.fields_json)
    } catch {
      fields = {}
    }
    return c.json({
      roll: {
        id: row.id,
        poseName: row.pose_name,
        poseId: row.pose_id,
        fields,
        prompt: row.prompt,
        negative: row.negative,
        createdAt: row.created_at,
      },
    })
  })

  app.delete('/dice/rolls/:id', (c) => {
    const result = runner.db.prepare('DELETE FROM dice_rolls WHERE id = ?').run(c.req.param('id'))
    return c.json({ deleted: result.changes })
  })

  // 造型模版：结构化 prompt + 角色 + poseName。填回时由页面写入 input，不重跑角色/pose 填词。
  app.get('/dice/templates', (c) => {
    const rows = runner.db
      .prepare(
        `SELECT id, name, character_slug, pose_name, pose_id, fields_json, created_at, updated_at
         FROM dice_templates ORDER BY updated_at DESC, rowid DESC`,
      )
      .all() as TemplateRow[]
    return c.json({ templates: rows.map(templateOf) })
  })

  app.post('/dice/templates', async (c) => {
    const body = await jsonObject(c.req)
    const name = templateName(body.name)
    const fields = templateFields(body.fields)
    const id = randomUUID()
    const now = runner.now().toISOString()
    const character = optionalText(body.character)
    const poseName = optionalText(body.poseName)
    const poseId = optionalText(body.poseId)
    runner.db
      .prepare(
        `INSERT INTO dice_templates
           (id, name, character_slug, pose_name, pose_id, fields_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, name, character, poseName, poseId, JSON.stringify(fields), now, now)
    return c.json(
      {
        template: {
          id,
          name,
          character,
          poseName,
          poseId,
          fields,
          createdAt: now,
          updatedAt: now,
        },
      },
      201,
    )
  })

  app.patch('/dice/templates/:id', async (c) => {
    const id = c.req.param('id')
    const body = await jsonObject(c.req)
    const current = runner.db
      .prepare(
        `SELECT id, name, character_slug, pose_name, pose_id, fields_json, created_at, updated_at
         FROM dice_templates WHERE id = ?`,
      )
      .get(id) as TemplateRow | undefined
    if (!current) throw new RunnerError(`template ${id} not found`, 404)
    const name = body.name === undefined ? current.name : templateName(body.name)
    const saving =
      body.fields !== undefined ||
      body.character !== undefined ||
      body.poseName !== undefined ||
      body.poseId !== undefined
    const character = saving ? optionalText(body.character) : current.character_slug
    const poseName = saving ? optionalText(body.poseName) : current.pose_name
    const poseId = saving ? optionalText(body.poseId) : current.pose_id
    const fieldsJson =
      body.fields === undefined ? current.fields_json : JSON.stringify(templateFields(body.fields))
    const now = runner.now().toISOString()
    runner.db
      .prepare(
        `UPDATE dice_templates
         SET name = ?, character_slug = ?, pose_name = ?, pose_id = ?, fields_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(name, character, poseName, poseId, fieldsJson, now, id)
    const row = runner.db
      .prepare(
        `SELECT id, name, character_slug, pose_name, pose_id, fields_json, created_at, updated_at
         FROM dice_templates WHERE id = ?`,
      )
      .get(id) as TemplateRow
    return c.json({ template: templateOf(row) })
  })

  app.delete('/dice/templates/:id', (c) => {
    const result = runner.db
      .prepare('DELETE FROM dice_templates WHERE id = ?')
      .run(c.req.param('id'))
    if (result.changes === 0) throw new RunnerError('template not found', 404)
    return c.json({ deleted: result.changes })
  })

  // 灵感出图：pose 图推 ComfyUI input 后建任务。workflow / step / 固定 prompt 来自 config.roll_config
  app.post('/dice/rolls/:id/generate', async (c) => {
    const rollId = c.req.param('id')
    const roll = runner.db
      .prepare('SELECT id, pose_id, prompt, negative FROM dice_rolls WHERE id = ?')
      .get(rollId) as
      | { id: string; pose_id: string | null; prompt: string; negative: string | null }
      | undefined
    if (!roll) throw new RunnerError('roll not found', 404)
    if (!roll.pose_id) throw new RunnerError('roll has no pose', 400)
    const poseId = roll.pose_id

    // manifest 里反查 pose 条目（depth/bone 路径 + 生成尺寸）
    const manifestPath = join(runner.dataDir, 'pose', 'manifest.json')
    if (!existsSync(manifestPath)) {
      throw new RunnerError('data/pose/manifest.json missing', 404)
    }
    interface PoseVariant {
      gen?: number[]
      depth?: string
      bone?: string
    }
    let entry: { variants?: Record<string, PoseVariant> } | null = null
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        poses?: Array<{ id: string; variants?: Record<string, PoseVariant> }>
      }
      entry = (manifest.poses ?? []).find((p) => p.id === poseId) ?? null
    } catch (err) {
      throw new RunnerError(`invalid manifest: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!entry) throw new RunnerError(`pose ${poseId} not in manifest`, 404)
    const variant = Object.values(entry.variants ?? {}).find((v) => v.gen && v.depth && v.bone)
    if (!variant) throw new RunnerError(`pose ${poseId} has no usable variant`, 404)

    // pose 图推 ComfyUI input（任务链无自动上传，必须先 await 再建任务）
    const client = runner.clients[0]
    if (!client) throw new RunnerError('no ComfyUI instance')
    const sub = `dice/${rollId}`
    const readPoseFile = (rel: string, label: string): Uint8Array => {
      const path = join(runner.dataDir, rel)
      if (!existsSync(path)) {
        throw new RunnerError(`pose ${label} file missing: ${rel}`, 404)
      }
      return new Uint8Array(readFileSync(path))
    }
    const depthBytes = readPoseFile(variant.depth as string, 'depth')
    const boneBytes = readPoseFile(variant.bone as string, 'bone')
    await client.uploadBytes(depthBytes, 'depth.png', sub)
    await client.uploadBytes(boneBytes, 'bone.png', sub)

    const gen = variant.gen as number[]
    const seed = runner.randomSeed()
    const rollConfig = readRollConfig(runner.db)
    const task = createTask(
      runner.db,
      {
        task: `dice-roll-${rollId.slice(0, 8)}`,
        workName: 'baseline',
        workflowName: rollConfig.workflowName,
        ...(rollConfig.version ? { version: rollConfig.version } : {}),
        payload: {
          positive: joinPrompt(rollConfig.workflowPositive, roll.prompt),
          negative: joinPrompt(rollConfig.workflowNegative, roll.negative ?? ''),
          pose_image: `${sub}/bone.png`,
          depth_image: `${sub}/depth.png`,
          width: gen[0],
          height: gen[1],
          seed,
          batch: 1,
          denoise: 1.0,
          skeleton_strength: 1.0,
          depth_strength: 0.5,
          step: rollConfig.step,
          lora_strength: 1.0,
        },
      },
      runner.now(),
      runner.randomSeed,
      runner.dataDir,
    )
    const recordId = randomUUID()
    runner.db
      .prepare(
        'INSERT INTO dice_roll_tasks (id, roll_id, task_id, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(recordId, rollId, task.id, runner.now().toISOString())
    return c.json({ id: recordId, taskId: task.id, seed }, 201)
  })

  app.get('/dice/rolls/:id/generations', (c) => {
    const rollId = c.req.param('id')
    const rows = runner.db
      .prepare(
        `SELECT t.id, t.task_id, tk.status, tk.output_path, tk.process_json, tk.error, tk.input_json,
                tk.created_at AS task_created_at, t.created_at
         FROM dice_roll_tasks t
         JOIN tasks tk ON tk.id = t.task_id
         WHERE t.roll_id = ?
         ORDER BY t.created_at DESC, t.rowid DESC`,
      )
      .all(rollId) as Array<{
      id: string
      task_id: string
      status: string
      output_path: string | null
      process_json: string | null
      error: string | null
      input_json: string | null
      task_created_at: string
      created_at: string
    }>
    return c.json({
      generations: rows.map((row) => {
        let seed: number | null = null
        try {
          seed = (JSON.parse(row.input_json ?? '{}') as { seed?: number }).seed ?? null
        } catch {
          seed = null
        }
        let outputs: string[] = []
        try {
          // resultPaths：单产物存裸字符串，多产物存 JSON 数组
          const parsed = JSON.parse(row.output_path ?? '') as unknown
          outputs = Array.isArray(parsed) ? (parsed as string[]) : []
        } catch {
          outputs =
            row.output_path && row.output_path !== '' && row.output_path !== '[]'
              ? [row.output_path]
              : []
        }
        // 旧任务（adapter 无 outputs 时期）产物记在 process_json 里，兜底补上
        if (outputs.length === 0 && row.process_json) {
          try {
            const items = JSON.parse(row.process_json) as Array<{ path?: unknown }>
            outputs = items
              .map((item) => (typeof item.path === 'string' ? item.path : ''))
              .filter((p) => p.startsWith('output/'))
          } catch {
            // 忽略
          }
        }
        return {
          id: row.id,
          taskId: row.task_id,
          status: row.status,
          outputs,
          seed,
          error: row.error,
          createdAt: row.created_at,
        }
      }),
    })
  })
}

interface TemplateRow {
  id: string
  name: string
  character_slug: string | null
  pose_name: string | null
  pose_id: string | null
  fields_json: string
  created_at: string
  updated_at: string
}

function templateOf(row: TemplateRow) {
  let fields: unknown = {}
  try {
    fields = JSON.parse(row.fields_json)
  } catch {
    fields = {}
  }
  return {
    id: row.id,
    name: row.name,
    character: row.character_slug,
    poseName: row.pose_name,
    poseId: row.pose_id,
    fields,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function templateName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RunnerError('name must be a non-empty string')
  }
  return value.trim()
}

function templateFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RunnerError('fields must be an object')
  }
  return value as Record<string, unknown>
}

function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}
