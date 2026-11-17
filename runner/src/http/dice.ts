import type { Hono } from 'hono'
import { randomUUID } from 'node:crypto'

import { RunnerError } from '../errors.ts'
import { DEFAULT_DICE_FIELDS, transaction } from '../db.ts'
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

  app.delete('/dice/rolls/:id', (c) => {
    const result = runner.db.prepare('DELETE FROM dice_rolls WHERE id = ?').run(c.req.param('id'))
    return c.json({ deleted: result.changes })
  })
}
