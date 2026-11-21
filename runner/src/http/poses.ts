import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const asBuffer = (bytes: Uint8Array | ArrayBuffer): Buffer =>
  Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as ArrayBuffer)

import type { Hono } from 'hono'

import { gatewayHint } from '../chat/client.ts'
import { taskById, type TaskRow } from '../db.ts'
import { RunnerError } from '../errors.ts'
import { getHeadWorkflow } from '../generate.ts'
import { createJobRaw } from '../jobFactory.ts'
import { relativePath, viewTarget } from '../path.ts'
import { parseCanvasKey, resolveNearestBucket } from '../workflow/buckets.ts'
import { storedPaths } from '../task/records.ts'
import type { Runner } from '../task/queue.ts'
import type { AdapterMap } from '../workflow/binding.ts'
import { bytesOf, jsonObject, stringField } from './request.ts'

// pose 工具链的代码内 adapter（不依赖 work/work_workflows，功能保留但接口化）。
const bind = (type: string, name: string, input: string) => ({
  class_type: type,
  name,
  input,
})

const IMG2POSE_ADAPTER: AdapterMap = {
  inputs: {
    source_image: bind('LoadImage', 'Pose Source Image', 'image'),
    width: bind('ImageScale', 'Scale to Canvas', 'width'),
    height: bind('ImageScale', 'Scale to Canvas', 'height'),
    canvas_width: bind('EmptyImage', 'Dark Flat BG', 'width'),
    canvas_height: bind('EmptyImage', 'Dark Flat BG', 'height'),
    render_width: bind('SAM3DBody_Render', 'Skeleton 2D', 'width'),
    render_height: bind('SAM3DBody_Render', 'Skeleton 2D', 'height'),
  },
  outputs: { image: { class_type: 'SaveImage', name: 'Save Skeleton' } },
}

const DUAL_ADAPTER: AdapterMap = {
  inputs: {
    positive: bind('CLIPTextEncode', 'Positive', 'text'),
    negative: bind('CLIPTextEncode', 'Negative', 'text'),
    pose_image: bind('LoadImage', 'Skeleton Image', 'image'),
    depth_image: bind('LoadImage', 'Depth Image', 'image'),
    width: bind('EmptyLatentImage', 'Empty Latent 832x1216', 'width'),
    height: bind('EmptyLatentImage', 'Empty Latent 832x1216', 'height'),
    batch: bind('EmptyLatentImage', 'Empty Latent 832x1216', 'batch_size'),
    seed: { class_type: 'KSampler', name: 'Base KSampler', input: 'seed' },
  },
  outputs: { image: { class_type: 'SaveImage', name: 'Save' } },
}

// pose 动作词兜底（完整表在 tools/pose-name-tags.json，这里只留 runner 需要的最小集）
export const POSE_ACTIONS: Record<string, string[]> = {
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
export const POSE_RATIOS: Record<string, { width: number; height: number }> = {
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

export interface PoseGuide {
  view?: string[]
  shot?: string[]
  framing?: string[]
}

export interface Img2PoseParams {
  poseName: string
  // data/ 相对路径（upload 端点先把文件落到 data/uploads/pose_src/ 再传入）
  imageRel: string
  character?: string
  name?: string
  description?: string
  tags?: string[]
  guide?: PoseGuide
  note?: string
  ratio?: string
}

export interface Img2PoseResult {
  poseId: string
  poseName: string
  ratio: string
  bucket: { width: number; height: number }
  paths: Record<string, string>
  img2poseTaskId: string
  dualTaskId: string
}

// img2pose 全链编排（2026-11-16 token 定）：
// 源图 → img2pose_v1 v2（BiRefNet 抠像纯色化 → MoGe depth + SAM3D 骨架）
//      → 组装 pose_pending/<poseName>/<id>/ 条目
//      → 自动提交 dual 测试任务（character-pose_dual_v1，异步不阻塞）
// JSON 与 multipart 两个入口共用本函数。
export async function runImg2Pose(runner: Runner, params: Img2PoseParams): Promise<Img2PoseResult> {
  const { poseName } = params
  const imageRel = relativePath(params.imageRel)
  const character = params.character ?? 'stocking_psg'
  const note = params.note ?? ''

  // 1. 源图字节（必须在 data/ 内）
  const srcAbs = join(runner.dataDir, imageRel)
  let srcBytes: Uint8Array
  try {
    srcBytes = new Uint8Array(readFileSync(srcAbs))
  } catch {
    throw new RunnerError(`source image not found in data/: ${imageRel}`, 404)
  }

  // 比例：入参限定三比例；缺省按源图比例最近邻自动归入（要求 PNG）
  let ratioKey = params.ratio
  if (ratioKey !== undefined) {
    if (!POSE_RATIOS[ratioKey]) {
      throw new RunnerError(
        `ratio must be one of ${Object.keys(POSE_RATIOS).join(' / ')} or omitted for auto`,
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
  const img2poseHead = getHeadWorkflow(runner.db, 'img2pose_v1')
  const task = createJobRaw(runner.db, runner.now(), {
    workflowName: 'img2pose_v1',
    adapter: IMG2POSE_ADAPTER,
    revisionApiJson: img2poseHead.revision.api_json,
    revisionId: img2poseHead.revision.id,
    task: `pose-${poseId}`,
    label: 'Img2Pose',
    payload: {
      source_image: `${srcSub}/source_orig.png`,
      width: canvas.width,
      height: canvas.height,
      canvas_width: canvas.width,
      canvas_height: canvas.height,
      render_width: canvas.width,
      render_height: canvas.height,
    },
  })
  const done = await pollTask(runner, task.jobId, 300_000)
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
  const tags = joinTags(actions, params.tags)

  // 5. dual 测试任务（异步，不阻塞条目落盘）
  //    底图尺寸不焊死：按 pose 画布在 sdxl 谱系 bucket 里取最近邻。
  const bucket = resolveNearestBucket('sdxl', canvas.width, canvas.height)
  await client.uploadBytes(new Uint8Array(depth), 'depth.png', srcSub)
  await client.uploadBytes(new Uint8Array(skeleton), 'skeleton.png', srcSub)
  const dualHead = getHeadWorkflow(runner.db, 'character-pose_dual_v1')
  const dualTask = createJobRaw(runner.db, runner.now(), {
    workflowName: 'character-pose_dual_v1',
    adapter: DUAL_ADAPTER,
    revisionApiJson: dualHead.revision.api_json,
    revisionId: dualHead.revision.id,
    task: `pose-dual-${poseId}`,
    label: 'Pose Dual',
    payload: {
      positive: dualPositive(runner, character, actions, tags),
      negative: dualNegative(runner, character),
      pose_image: `${srcSub}/skeleton.png`,
      depth_image: `${srcSub}/depth.png`,
      width: bucket.width,
      height: bucket.height,
      batch: 1,
      seed: 'random',
    },
  })

  const meta = {
    id: poseId,
    poseName,
    name: params.name ?? `${poseName} (img2pose v2)`,
    description: params.description ?? '',
    enabled: false,
    source: 'img2pose',
    canvases: [canvasKey(canvas)],
    ratio: ratioKey,
    defects: [] as string[],
    tags,
    guide: params.guide ?? {
      view: ['three-quarter'],
      shot: ['full body'],
      framing: ['centered'],
    },
    img2poseTaskId: task.jobId,
    dualTaskId: dualTask.jobId,
    note:
      `img2pose v2 全链产物（BiRefNet 抠像→纯深色底→MoGe depth + SAM3D 骨架）。` +
      `dual 测试任务见同批返回。${note}`,
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))

  return {
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
    img2poseTaskId: task.jobId,
    dualTaskId: dualTask.jobId,
  }
}

export function mountPoses(app: Hono, runner: Runner): void {
  // LLM 读图生成 meta 草稿（web 上传页「识别 meta」按钮用）。
  // 入口：multipart {file} 或 JSON {image: data/ 相对路径}；走 gateway vision 模型。
  app.post('/poses/describe', async (c) => {
    const contentType = c.req.header('content-type') ?? ''
    let bytes: Uint8Array
    if (contentType.includes('application/json')) {
      const body = await jsonObject(c.req)
      const imageRel = relativePath(stringField(body, 'image'))
      try {
        bytes = new Uint8Array(readFileSync(join(runner.dataDir, imageRel)))
      } catch {
        throw new RunnerError(`image not found in data/: ${imageRel}`, 404)
      }
    } else {
      const body = await c.req.parseBody()
      const file = body.file
      if (!(file instanceof File)) throw new RunnerError('file is required')
      bytes = new Uint8Array(await file.arrayBuffer())
    }
    if (bytes.byteLength === 0) throw new RunnerError('image is empty', 400)
    if (bytes.byteLength > 10_000_000) throw new RunnerError('image too large (>10MB)', 400)
    return c.json(await describePoseMeta(runner, bytes))
  })

  // JSON 入口：源图必须已在 data/ 内（脚本/自动化调用）
  app.post('/poses/from-image', async (c) => {
    const body = await jsonObject(c.req)
    const result = await runImg2Pose(runner, {
      poseName: stringField(body, 'poseName').trim(),
      imageRel: stringField(body, 'image'),
      character: (body.character ?? 'stocking_psg') as string,
      name: (body.name as string | undefined) ?? undefined,
      description: (body.description as string | undefined) ?? undefined,
      tags: body.tags as string[] | undefined,
      note: (body.note ?? '') as string,
      ratio: body.ratio as string | undefined,
    })
    return c.json(result, 201)
  })

  // multipart 入口（web 页面用）：直接上传源图，先落 data/uploads/pose_src/ 再走同一管线。
  // 只收 PNG——源图拍摄规范（pose_pending/README.md）与 512 系归一都按 PNG 链路走。
  app.post('/poses/upload', async (c) => {
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) throw new RunnerError('file is required (PNG)')
    const poseName = typeof body.poseName === 'string' ? body.poseName.trim() : ''
    if (!/^[a-z][a-z0-9_]*$/.test(poseName)) {
      throw new RunnerError('poseName must be a snake_case category name', 400)
    }
    const ratio = typeof body.ratio === 'string' && body.ratio !== '' ? body.ratio : undefined
    if (ratio !== undefined && !POSE_RATIOS[ratio]) {
      throw new RunnerError(
        `ratio must be one of ${Object.keys(POSE_RATIOS).join(' / ')} or empty for auto`,
        400,
      )
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (ratio === undefined) pngSize(bytes) // 自动归比例需要读尺寸，顺便验 PNG

    const poseId = String(runner.now().getTime())
    const safeName = (file.name || 'source.png').split(/[\\/]/).pop() ?? 'source.png'
    const cleaned = safeName.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')
    const imageRel = `uploads/pose_src/${poseId}_${cleaned}`
    mkdirSync(join(runner.dataDir, 'uploads/pose_src'), { recursive: true })
    writeFileSync(join(runner.dataDir, imageRel), asBuffer(bytes))

    const tags =
      typeof body.tags === 'string' && body.tags.trim() !== ''
        ? body.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : undefined

    // LLM 草稿的 guide 随表单隐藏域一起提交（JSON 字符串）
    let guide: PoseGuide | undefined
    if (typeof body.guide === 'string' && body.guide.trim() !== '') {
      try {
        guide = sanitizeGuide(JSON.parse(body.guide))
      } catch {
        throw new RunnerError('guide must be valid JSON', 400)
      }
    }

    const result = await runImg2Pose(runner, {
      poseName,
      imageRel,
      character: typeof body.character === 'string' && body.character !== '' ? body.character : undefined,
      name: typeof body.name === 'string' && body.name !== '' ? body.name : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      tags,
      guide,
      note: typeof body.note === 'string' ? body.note : '',
      ratio,
    })
    return c.json({ ...result, image: imageRel }, 201)
  })
}

// ---- LLM meta 草稿 ----

const DESCRIBE_SYSTEM = `You label reference photos for a drawing-reference pose library (anime/illustration style).
Look at the person's pose ONLY: body orientation, limbs, hands, head direction, camera angle.
Ignore identity, clothing brand details and background; clothing only matters if it changes the pose silhouette.
Return STRICT JSON only — no markdown fence, no commentary — with exactly this shape:
{
  "name": "short English name, 2-6 words, describing the pose",
  "description": "one or two English sentences describing the pose precisely: torso orientation, each arm and hand, each leg, head direction",
  "tags": ["3-8 lowercase danbooru-style action tags, e.g. sitting, one knee up, arm behind head"],
  "guide": {"view": [], "shot": [], "framing": []}
}
guide arrays contain lowercase phrases chosen from:
  view: front / three-quarter / side / back / from above / from below
  shot: full body / upper body / lower body
  framing: centered / off-center / close-up
Use [] for anything uncertain.`

interface MetaDraft {
  name: string
  description: string
  tags: string[]
  guide: PoseGuide
}

async function describePoseMeta(runner: Runner, bytes: Uint8Array): Promise<MetaDraft> {
  if (!runner.chat) throw new RunnerError(gatewayHint, 503)
  const client = runner.chat
  const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
  const reply = await client.complete(
    client.visionModel,
    [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: 'Label this pose reference photo.' },
        ],
      },
    ],
    DESCRIBE_SYSTEM,
  )
  return parseMetaDraft(reply)
}

function parseMetaDraft(reply: string): MetaDraft {
  const text = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new RunnerError(`LLM returned invalid JSON: ${text.slice(0, 200)}`, 502)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RunnerError('LLM draft must be a JSON object', 502)
  }
  const obj = raw as Record<string, unknown>
  const name = typeof obj.name === 'string' ? obj.name.trim() : ''
  const description = typeof obj.description === 'string' ? obj.description.trim() : ''
  const tags = sanitizeStringList(obj.tags)
  if (name === '' || tags.length === 0) {
    throw new RunnerError('LLM draft missing name or tags', 502)
  }
  const guide = sanitizeGuide(obj.guide)
  return { name, description, tags, guide }
}

function sanitizeStringList(value: unknown, max = 12): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max)
}

function sanitizeGuide(value: unknown): PoseGuide {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const obj = value as Record<string, unknown>
  return {
    view: sanitizeStringList(obj.view, 4),
    shot: sanitizeStringList(obj.shot, 4),
    framing: sanitizeStringList(obj.framing, 4),
  }
}function recipeOf(runner: Runner, character: string): Record<string, any> {
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
