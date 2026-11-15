import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const asBuffer = (bytes: Uint8Array | ArrayBuffer): Buffer =>
  Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as ArrayBuffer)

import type { Hono } from 'hono'

import { taskById, type TaskRow } from '../db.ts'
import { RunnerError } from '../errors.ts'
import { relativePath, viewTarget } from '../path.ts'
import { createTask, storedPaths } from '../task/records.ts'
import type { Runner } from '../task/queue.ts'
import { bytesOf, jsonObject, stringField } from './request.ts'

// pose 动作词兜底（完整表在 tools/pose-name-tags.json，这里只留 runner 需要的最小集）
const POSE_ACTIONS: Record<string, string[]> = {
  sitting: ['sitting', 'on floor'],
  standing: ['standing'],
  kneeling: ['kneeling'],
  lying: ['lying', 'on back'],
  squatting: ['squatting'],
  all_fours: ['all fours'],
  split_leg: ['sitting', 'legs apart'],
  suspended: ['suspended'],
}

const OUT_WIDTH = 832
const OUT_HEIGHT = 1216

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function pollTask(runner: Runner, id: string, timeoutMs: number): Promise<TaskRow> {
  const deadline = runner.now().getTime() + timeoutMs
  for (;;) {
    const task = taskById(runner.db, id)
    if (['completed', 'failed', 'cancelled', 'timeout'].includes(task.status)) {
      return task
    }
    if (runner.now().getTime() > deadline) {
      throw new RunnerError(`task ${id} did not settle within ${timeoutMs}ms`)
    }
    await sleep(2000)
  }
}

function productPath(paths: string[], prefix: string): string {
  const hit = paths.find((p) => p.includes(`/${prefix}_`) || p.endsWith(`/${prefix}.png`))
  if (!hit) throw new RunnerError(`img2pose output missing: ${prefix}`)
  return hit
}

function joinTags(...groups: Array<string[] | undefined>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const g of groups) {
    if (!g) continue
    for (const t of g) {
      const k = t.trim().toLowerCase()
      if (!k || seen.has(k)) continue
      seen.add(k)
      out.push(t.trim())
    }
  }
  return out
}

export function mountPoses(app: Hono, runner: Runner): void {
  // img2pose 全链编排（2026-11-16 token 定）：
  // 源图 → img2pose_v1 v2（BiRefNet 抠像纯色化 → MoGe depth + SAM3D 骨架）
  //      → 组装 pose_pending/<poseName>/<id>/ 条目
  //      → 自动提交 dual 测试任务（character-pose_dual_v1，异步不阻塞）
  app.post('/poses/from-image', async (c) => {
    const body = await jsonObject(c.req)
    const poseName = stringField(body, 'poseName').trim()
    const imageRel = relativePath(stringField(body, 'image'))
    const character = (body.character ?? 'stocking_psg') as string
    const note = (body.note ?? '') as string

    // 1. 源图字节（必须在 data/ 内）
    const srcAbs = join(runner.dataDir, imageRel)
    let srcBytes: Uint8Array
    try {
      srcBytes = new Uint8Array(readFileSync(srcAbs))
    } catch {
      throw new RunnerError(`source image not found in data/: ${imageRel}`, 404)
    }

    const poseId = String(runner.now().getTime())
    const client = runner.clients[0]
    if (!client) throw new RunnerError('no ComfyUI instance')

    // 2. 推源图到 ComfyUI input（task 链路无自动上传）
    const srcSub = `pose_src/${poseId}`
    await client.uploadBytes(srcBytes, 'source_orig.png', srcSub)

    // 3. img2pose（现行版本 = main head，v2 预处理链）
    const task = createTask(
      runner.db,
      {
        task: `pose-${poseId}`,
        workName: 'img2pose',
        workflowName: 'img2pose_v1',
        payload: { source_image: `${srcSub}/source_orig.png` },
      },
      runner.now(),
      runner.randomSeed,
      runner.dataDir,
    )
    const done = await pollTask(runner, task.id, 300_000)
    if (done.status !== 'completed') {
      throw new RunnerError(`img2pose task ${done.status}: ${done.error ?? ''}`)
    }

    // 4. 拉产物 → 写 pose_pending 条目
    const outs = storedPaths(done).filter((p) => p.startsWith('output/'))
    const pick = async (prefix: string) => {
      const path = productPath(outs, prefix)
      const target = viewTarget(path)
      const file = await client.viewFile(target.type, target.subfolder, target.filename)
      return bytesOf(file.bytes)
    }
    const flat = await pick('flat')
    const depth = await pick('depth')
    const depthPreview = await pick('depth_preview')
    const skeleton = await pick('skeleton')

    const dir = join(runner.dataDir, 'pose_pending', poseName, poseId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'source_orig.png'), asBuffer(srcBytes))
    writeFileSync(join(dir, 'source.png'), asBuffer(flat))
    writeFileSync(join(dir, 'depth.png'), asBuffer(depth))
    writeFileSync(join(dir, 'depth_preview.png'), asBuffer(depthPreview))
    writeFileSync(join(dir, 'skeleton.png'), asBuffer(skeleton))

    const actions = POSE_ACTIONS[poseName] ?? [poseName]
    const tags = joinTags(actions, body.tags as string[] | undefined)
    const meta = {
      id: poseId,
      poseName,
      name: (body.name as string | undefined) ?? `${poseName} (img2pose v2)`,
      description: (body.description as string | undefined) ?? '',
      enabled: false,
      source: 'img2pose',
      canvases: [`${OUT_WIDTH}${OUT_HEIGHT}`],
      defects: [] as string[],
      tags,
      guide: (body.guide as unknown | undefined) ?? {
        view: ['three-quarter'],
        shot: ['full body'],
        framing: ['centered'],
      },
      note:
        `img2pose v2 全链产物（BiRefNet 抠像→纯深色底→MoGe depth + SAM3D 骨架）。` +
        `dual 测试任务见同批返回。${note}`,
    }
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))

    // 5. dual 测试任务（异步，不阻塞条目落盘）
    await client.uploadBytes(flat, 'depth.png', srcSub)
    await client.uploadBytes(skeleton, 'skeleton.png', srcSub)
    const dualTask = createTask(
      runner.db,
      {
        task: `pose-dual-${poseId}`,
        workName: 'makeImage',
        workflowName: 'character-pose_dual_v1',
        payload: {
          positive: dualPositive(runner, character, actions, tags),
          negative: dualNegative(runner, character),
          pose_image: `${srcSub}/skeleton.png`,
          depth_image: `${srcSub}/depth.png`,
          width: OUT_WIDTH,
          height: OUT_HEIGHT,
          batch: 1,
        },
      },
      runner.now(),
      runner.randomSeed,
      runner.dataDir,
    )

    return c.json(
      {
        poseId,
        poseName,
        paths: {
          source: `pose_pending/${poseName}/${poseId}/source.png`,
          sourceOrig: `pose_pending/${poseName}/${poseId}/source_orig.png`,
          depth: `pose_pending/${poseName}/${poseId}/depth.png`,
          depthPreview: `pose_pending/${poseName}/${poseId}/depth_preview.png`,
          skeleton: `pose_pending/${poseName}/${poseId}/skeleton.png`,
          meta: `pose_pending/${poseName}/${poseId}/meta.json`,
        },
        img2poseTaskId: task.id,
        dualTaskId: dualTask.id,
      },
      201,
    )
  })
}

// recipe prompt 组装（与 experiments/run_stk_dual.mjs 同规则）
function recipeOf(runner: Runner, character: string): Record<string, any> {
  const raw = readFileSync(
    join(runner.dataDir, 'character', character, 'recipe.json'),
    'utf8',
  )
  return JSON.parse(raw) as Record<string, any>
}

function dualPositive(
  runner: Runner,
  character: string,
  actions: string[],
  tags: string[],
): string {
  const recipe = recipeOf(runner, character)
  const L = recipe.outfits?.default?.layers ?? {
    base: recipe.outfits?.default?.tags ?? [],
    wear: [],
  }
  const outfitTags = [...(L.base ?? []), ...(L.wear ?? [])]
  const general = joinTags(
    [recipe.person?.character_tag, recipe.person?.series_tag].filter(Boolean) as string[],
    recipe.person?.tags,
    outfitTags,
    actions,
    tags,
    ['simple background', 'white background', 'solo', '1girl'],
  )
  return joinTags(general, ['rating:general', 'no explicit'], [
    'masterpiece',
    'high score',
    'great score',
    'absurdres',
  ]).join(', ')
}

function dualNegative(runner: Runner, character: string): string {
  let extra: string[] = []
  try {
    extra = recipeOf(runner, character).negative_tags ?? []
  } catch {
    extra = []
  }
  return joinTags(
    [
      'lowres', 'bad anatomy', 'bad hands', 'text', 'error', 'missing finger',
      'extra digits', 'fewer digits', 'cropped', 'worst quality', 'low quality',
      'low score', 'bad score', 'average score', 'signature', 'watermark',
      'username', 'blurry', 'nsfw', 'explicit',
    ],
    extra,
  ).join(', ')
}
