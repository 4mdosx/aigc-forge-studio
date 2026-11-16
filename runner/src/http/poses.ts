import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const asBuffer = (bytes: Uint8Array | ArrayBuffer): Buffer =>
  Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as ArrayBuffer)

import type { Hono } from 'hono'

import { taskById, type TaskRow } from '../db.ts'
import { RunnerError } from '../errors.ts'
import { relativePath, viewTarget } from '../path.ts'
import { parseCanvasKey, resolveNearestBucket } from '../workflow/buckets.ts'
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

// pose 画布三比例（2026-11-16 token 定）：pose 库统一 512 系存储，
// 接口只收这三个比例；底图尺寸由消费端按谱系 bucket 最近邻解析。
const POSE_RATIOS: Record<string, { width: number; height: number }> = {
  '2:3': { width: 512, height: 768 },
  '3:2': { width: 768, height: 512 },
  '1:1': { width: 512, height: 512 },
}

const canvasKey = ({ width, height }: { width: number; height: number }): string =>
  `${width}${height}`

// PNG IHDR 读取（宽高在固定偏移，big-endian uint32）。
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== sig[i]) throw new RunnerError('source image is not a PNG', 400)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

// 未显式给 ratio 时，按源图比例取三比例中最近邻（对数距离）。
function nearestRatio(width: number, height: number): string {
  const aspect = Math.log(width / height)
  let best = '2:3'
  let bestDist = Infinity
  for (const [key, { width: w, height: h }] of Object.entries(POSE_RATIOS)) {
    const dist = Math.abs(Math.log(w / h) - aspect)
    if (dist < bestDist) {
      best = key
      bestDist = dist
    }
  }
  return best
}

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

    // 比例：入参限定三比例；缺省按源图比例最近邻自动归入
    let ratioKey = body.ratio as string | undefined
    if (ratioKey !== undefined) {
      if (!POSE_RATIOS[ratioKey]) {
        throw new RunnerError(
          `ratio must be one of ${Object.keys(POSE_RATIOS).join(' / ')}`,
          400,
        )
      }
    } else {
      const size = pngSize(srcBytes)
      ratioKey = nearestRatio(size.width, size.height)
    }
    const canvas = POSE_RATIOS[ratioKey]

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
        payload: {
          source_image: `${srcSub}/source_orig.png`,
          width: canvas.width,
          height: canvas.height,
          canvas_width: canvas.width,
          canvas_height: canvas.height,
          render_width: canvas.width,
          render_height: canvas.height,
        },
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
      canvases: [canvasKey(canvas)],
      ratio: ratioKey,
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
    //    底图尺寸不焊死：按 pose 画布在 sdxl 谱系 bucket 里取最近邻。
    const bucket = resolveNearestBucket('sdxl', canvas.width, canvas.height)
    await client.uploadBytes(depth, 'depth.png', srcSub)
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
          width: bucket.width,
          height: bucket.height,
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
        ratio: ratioKey,
        bucket,
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
      // depth ControlNet 会把黑背景解释成「远」，渲染成环境灰蓝渐变——
      // 接受为链路特征，此处只做轻度压制，不强求全白背景。
      'gradient background', 'colored background', 'depth of field',
    ],
    extra,
  ).join(', ')
}
