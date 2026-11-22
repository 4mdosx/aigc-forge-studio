#!/usr/bin/env node
// replica_fidelity.mjs — img2img 保真度天花板测试（2026-11-23）
//
// 问的问题：一张源图走 img2img，最好能做到多「一模一样」？
//
// 「正确用法」的五条，脚本里逐条落实：
//   1. 底图不裁切、不换比例（ImageScale crop=disabled，只对齐像素）
//   2. 尺寸贴源图原生像素量并凑到 8 的倍数，不硬套 1024 方图
//   3. prompt 必须描述底图里真实存在的东西（场景、机位、姿态），不能只写角色
//   4. denoise 从 0 开始 —— vae0 档走 Encode→Decode 不采样的纯 VAE 往返，
//      这是「一模一样」的物理天花板，任何 denoise>0 都不可能超过它
//   5. 每个 denoise 档都跑 LoRA on/off 对照，因为低 denoise 下 LoRA 会把底图
//      往训练分布拽，未必是帮手
//
// 用法：
//   node scripts_and_tools/replica_fidelity.mjs --dry
//   node scripts_and_tools/replica_fidelity.mjs --run FIDELITY-20261123

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, extname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const COMFY = process.env.COMFY_URL || 'http://192.168.8.136:8188'
const HOME = process.env.HOME || '/Users/token'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} 缺值`)
  return v
}
const flag = (n) => process.argv.includes(`--${n}`)

const RUN = arg('run', 'FIDELITY')
const DRY = flag('dry')
const FORCE = flag('force')
const CKPT = arg('ckpt', 'animagine-xl-4.0-zero.safetensors')
const LORA = arg('lora', 'ohou19-ohou-ohou-style-az-261122-140.safetensors')
const LORA_S = Number(arg('lora-strength', '1.0'))
const STEPS = Number(arg('steps', '32'))
const CFG = Number(arg('cfg', '6'))
const SAMPLER = arg('sampler', 'dpmpp_2m')
const SCHED = arg('scheduler', 'karras')
const SEED = Number(arg('seed', '1101'))
const ONLY = arg('only', '').split(',').map((s) => s.trim()).filter(Boolean)
const OUT = join(REPO, 'experiments/runs', RUN, 'fidelity')

const COMMON_NEG = 'lineart, cel shading, flat colors, outline, sketch, lowres, worst quality, low quality, bad anatomy, bad hands, extra fingers, text, signature, watermark, logo, multiple girls, chibi, 2d, flat lighting'

// prompt 描述的是底图里真实存在的东西，不是我们「希望」它变成什么
const SOURCES = [
  {
    id: 'shot',
    // 用户自己那张：768x1024 正好是标准 SDXL 竖桶，原样进
    path: join(HOME, '.workbuddy/clipboard-images/clipboard-2026-11-22T15-53-30-714Z-87c5abb0.jpg'),
    width: 768,
    height: 1024,
    pos: '1girl, playboy bunny, rabbit ears, black highleg leotard, black pantyhose, black gloves, high heels, long multicolored hair, looking at viewer, standing, full body, golden ornate hall, symmetrical composition, marble floor reflection, potted white roses on both sides, arched doorway, wall sconces, warm lighting',
  },
  {
    id: 'ohou1b38',
    // 训练集里人物最完整的一张：1216x684 -> 688（纵向 +4px，0.6%，为凑 8 的倍数）
    path: join(REPO, 'data/training-export/ohou19/img/20261122-001117-1b38.png'),
    width: 1216,
    height: 688,
    pos: '1girl, playboy bunny, rabbit ears, black leotard, black pantyhose, black gloves, high heels, long multicolored hair, looking at viewer, bar (place), indoors, wine bottles, red ambient light, fur-trimmed coat, lying, dutch angle',
  },
  {
    id: 'web',
    // danbooru 12602556（rating:s，原图 1160x2360）——训练集外的第三方图。
    // 缩到 768x1560 只缩小不放大，宽高比 0.4923 vs 原 0.4915，形变 0.16%。
    // 白底立绘、全身完整、机位正，正好是训练集里缺的那类构图。
    path: join(REPO, 'experiments/runs/FIDELITY-20261123/src/web-12602556-768x1560.png'),
    width: 768,
    height: 1560,
    pos: '1girl, solo, silver hair, very long hair, grey eyes, black crop top, black shorts, black belt, thigh strap, tall boots, standing, full body, looking at viewer, simple background, white background',
  },
  {
    id: 'ohou1b38c',
    // 同一张训练图，裁 4 行到 1216x680（不重采样），用来暴露「拉伸 vs 裁剪」
    // 那 0.6% 的几何误差到底吃掉多少 PSNR
    path: join(REPO, 'experiments/runs/FIDELITY-20261123/src/ohou1b38-1216x680.png'),
    width: 1216,
    height: 680,
    pos: '1girl, playboy bunny, rabbit ears, black leotard, black pantyhose, black gloves, high heels, long multicolored hair, looking at viewer, bar (place), indoors, wine bottles, red ambient light, fur-trimmed coat, lying, dutch angle',
  },
]

const DENOISE = [0.1, 0.15, 0.2, 0.3]
const LORA_MODE = [
  { tag: 'lora', strength: LORA_S },
  { tag: 'nolora', strength: 0 },
]

const jobs = []
for (const src of SOURCES) {
  // vae0：不采样，纯编解码往返，给天花板
  for (const lm of LORA_MODE) {
    jobs.push({ src, mode: 'vae0', denoise: 0, lora: lm, seed: SEED })
  }
  for (const d of DENOISE) {
    for (const lm of LORA_MODE) {
      jobs.push({ src, mode: `d${String(Math.round(d * 100)).padStart(3, '0')}`, denoise: d, lora: lm, seed: SEED })
    }
  }
}
const finalJobs = ONLY.length ? jobs.filter((j) => ONLY.some((k) => `${j.src.id}-${j.mode}-${j.lora.tag}`.includes(k))) : jobs

console.log(`${SOURCES.length} 张源图 × ${DENOISE.length + 1} 档 × ${LORA_MODE.length} 种 LoRA 状态 = ${finalJobs.length} 张`)
for (const s of SOURCES) console.log(`  ${s.id}: ${basename(s.path)} → ${s.width}x${s.height}`)
if (DRY) {
  for (const j of finalJobs) console.log(`  ${j.src.id}-${j.mode}-${j.lora.tag}`)
  process.exit(0)
}

async function upload(src) {
  const buf = readFileSync(src)
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 12)
  const ext = extname(src).toLowerCase()
  const name = `fidelity_src_${hash}${ext}`
  const form = new FormData()
  form.append('image', new Blob([buf], { type: ext === '.png' ? 'image/png' : 'image/jpeg' }), name)
  form.append('overwrite', 'true')
  form.append('type', 'input')
  const res = await fetch(`${COMFY}/upload/image`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`上传失败 ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name
}

function buildWorkflow(job, srcRef) {
  const { src } = job
  const useLora = job.lora.strength > 0
  const wf = { '15': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } } }
  const model = useLora ? ['17', 0] : ['15', 0]
  const clip = useLora ? ['17', 1] : ['15', 1]
  if (useLora) {
    wf['17'] = { class_type: 'LoraLoader', inputs: { lora_name: LORA, strength_model: job.lora.strength, strength_clip: job.lora.strength, model: ['15', 0], clip: ['15', 1] } }
  }
  wf['100'] = { class_type: 'LoadImage', inputs: { image: srcRef } }
  // crop=disabled：拉伸到目标尺寸，绝不裁掉画面。目标尺寸本来就贴着源图比例，
  // 误差在 1% 以内，肉眼无感；换成 center crop 会切掉人物，那才是保真度杀手。
  wf['101'] = { class_type: 'ImageScale', inputs: { image: ['100', 0], upscale_method: 'lanczos', width: src.width, height: src.height, crop: 'disabled' } }
  wf['102'] = { class_type: 'VAEEncode', inputs: { pixels: ['101', 0], vae: ['15', 2] } }
  wf['14'] = { class_type: 'VAEDecode', inputs: { samples: ['102', 0], vae: ['15', 2] } }
  if (job.mode !== 'vae0') {
    wf['10'] = { class_type: 'CLIPTextEncode', inputs: { text: src.pos, clip } }
    wf['11'] = { class_type: 'CLIPTextEncode', inputs: { text: COMMON_NEG, clip } }
    wf['12'] = {
      class_type: 'KSampler',
      inputs: { seed: job.seed, steps: STEPS, cfg: CFG, sampler_name: SAMPLER, scheduler: SCHED, denoise: job.denoise, model, positive: ['10', 0], negative: ['11', 0], latent_image: ['102', 0] },
    }
    wf['14'].inputs.samples = ['12', 0]
  }
  wf['7'] = { class_type: 'SaveImage', inputs: { images: ['14', 0], filename_prefix: `fidelity/${RUN}/${src.id}-${job.mode}-${job.lora.tag}` } }
  return wf
}

async function waitFor(id) {
  const deadline = Date.now() + 600_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const h = await (await fetch(`${COMFY}/history/${id}`)).json()
    const e = h[id]
    if (!e) continue
    if (e.status?.status_str === 'error') throw new Error(JSON.stringify(e.status).slice(0, 400))
    const imgs = Object.values(e.outputs || {}).flatMap((o) => o.images || [])
    if (!imgs.length) continue
    const im = imgs[0]
    const url = `${COMFY}/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || '')}&type=${im.type || 'output'}`
    return Buffer.from(await (await fetch(url)).arrayBuffer())
  }
  throw new Error('超时 600s')
}

mkdirSync(OUT, { recursive: true })

const stats = await fetch(`${COMFY}/system_stats`).then((r) => r.json()).catch(() => null)
if (!stats) throw new Error(`ComfyUI 不可达 ${COMFY}`)
const dev = (stats.devices || [])[0] || {}
const q = await fetch(`${COMFY}/queue`).then((r) => r.json())
console.log(`ComfyUI ${dev.name || '?'}  VRAM free ${(dev.vram_free / 1e9).toFixed(1)}GB  队列 ${(q.queue_running || []).length}+${(q.queue_pending || []).length}\n`)

const refs = new Map()
for (const s of SOURCES) {
  if (!existsSync(s.path)) throw new Error(`源图不存在: ${s.path}`)
  if (finalJobs.some((j) => j.src.id === s.id)) refs.set(s.id, await upload(s.path))
}

const results = []
for (const job of finalJobs) {
  const tag = `${job.src.id}-${job.mode}-${job.lora.tag}`
  const dest = join(OUT, `${tag}.png`)
  if (existsSync(dest) && !FORCE) {
    console.log(`skip ${tag}`)
    results.push({ tag })
    continue
  }
  const t0 = Date.now()
  const res = await fetch(`${COMFY}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: buildWorkflow(job, refs.get(job.src.id)), client_id: 'lain-fidelity' }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`提交失败 ${tag}: ${JSON.stringify(body).slice(0, 300)}`)
  writeFileSync(dest, await waitFor(body.prompt_id))
  console.log(`✓ ${tag}  ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  results.push({ tag, file: `fidelity/${tag}.png` })
}

writeFileSync(join(REPO, 'experiments/runs', RUN, 'report.json'), JSON.stringify({ run: RUN, ckpt: CKPT, lora: LORA, seed: SEED, steps: STEPS, cfg: CFG, sources: SOURCES.map(({ path, ...s }) => ({ ...s, file: basename(path) })), results }, null, 2))
console.log(`\n报告 experiments/runs/${RUN}/report.json`)
