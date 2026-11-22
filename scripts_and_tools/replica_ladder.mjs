#!/usr/bin/env node
// replica_ladder.mjs — 「能还原到什么程度」的阶梯实验（2026-11-22）
//
// 问题：同源训练集、同角色同服装，T2I 出来的图和训练集某张为什么不像？
// 回答方式：把「构图信息从哪来」当作唯一变量，逐档抬升。
//
//   t2i-user   : 纯文本，prompt 只写角色/服装（= 当前做法）
//   t2i-scene  : 纯文本，补上场景与机位词（从源图 caption 抄）
//   i2i-d020.. : img2img，底图就是源图本身，denoise 从 0.20 抬到 0.55
//
// 度量：与源图的 DINOv3-H CLS 余弦 + 像素 L1（归一化后）。
//
// 用法（仓库根目录）：
//   node scripts_and_tools/replica_ladder.mjs --dry
//   node scripts_and_tools/replica_ladder.mjs --run REPLICA-20261123
//
// 产物：experiments/runs/<run>/ladder/*.png + report.json + contactsheet.png

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, extname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const COMFY = process.env.COMFY_URL || 'http://192.168.8.136:8188'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} 缺值`)
  return v
}
const flag = (n) => process.argv.includes(`--${n}`)

const RUN = arg('run', 'REPLICA-LADDER')
const DRY = flag('dry')
const FORCE = flag('force')
const CKPT = arg('ckpt', 'animagine-xl-4.0-zero.safetensors')
const LORA = arg('lora', 'ohou19-ohou-ohou-style-az-261122-140.safetensors')
const LORA_S = Number(arg('lora-strength', '1.0'))
const SRC = resolve(arg('source', join(REPO, 'data/training-export/ohou19/img/20261122-001117-1b38.png')))
const W = Number(arg('width', '1024'))
const H = Number(arg('height', '576'))
const STEPS = Number(arg('steps', '30'))
const CFG = Number(arg('cfg', '6'))
const SAMPLER = arg('sampler', 'dpmpp_2m')
const SCHED = arg('scheduler', 'karras')
const SEEDS = arg('seeds', '1101,1102').split(',').map(Number).filter(Boolean)
const OUT = join(REPO, 'experiments/runs', RUN, 'ladder')

const NEG = 'lineart, cel shading, flat colors, outline, sketch, lowres, worst quality, low quality, bad anatomy, bad hands, extra fingers, text, signature, watermark, logo, multiple girls, chibi, 2d, flat lighting'

// 用户截图那张用的 prompt，原样保留（含它缺的东西）
const USER_POS = '1girl, playboy bunny, rabbit ears, black highleg leotard, black pantyhose, black gloves, high heels, long multicolored hair, full body, looking at viewer'
// 补上源图里实际存在、但用户没写的场景/机位/材质词
const SCENE_POS = `${USER_POS}, bar (place), indoors, wine bottles, wine glass, red ambient light, fur-trimmed coat, lying, dutch angle, @style-v1`

const jobs = []
for (const seed of SEEDS) {
  jobs.push({ id: 't2i-user', kind: 't2i', seed, denoise: 1.0, pos: USER_POS })
  jobs.push({ id: 't2i-scene', kind: 't2i', seed, denoise: 1.0, pos: SCENE_POS })
  for (const d of [0.2, 0.3, 0.4, 0.55]) {
    jobs.push({ id: `i2i-d${String(Math.round(d * 100)).padStart(3, '0')}`, kind: 'i2i', seed, denoise: d, pos: SCENE_POS })
  }
}

console.log(`源图 ${basename(SRC)} → ${W}x${H} | LoRA ${LORA} @${LORA_S} | ${jobs.length} 个组合`)
if (DRY) {
  for (const j of jobs) console.log(`  ${j.id}-s${j.seed}  denoise=${j.denoise}`)
  process.exit(0)
}
if (!existsSync(SRC)) throw new Error(`源图不存在: ${SRC}`)

async function upload(src) {
  const buf = readFileSync(src)
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 12)
  const ext = extname(src).toLowerCase()
  const name = `replica_src_${hash}${ext}`
  const form = new FormData()
  form.append('image', new Blob([buf], { type: ext === '.png' ? 'image/png' : 'image/jpeg' }), name)
  form.append('overwrite', 'true')
  form.append('type', 'input')
  const res = await fetch(`${COMFY}/upload/image`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`上传失败 ${res.status}`)
  const j = await res.json()
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name
}

function buildWorkflow(job, srcRef) {
  const wf = {
    '15': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
    '17': { class_type: 'LoraLoader', inputs: { lora_name: LORA, strength_model: LORA_S, strength_clip: LORA_S, model: ['15', 0], clip: ['15', 1] } },
    '10': { class_type: 'CLIPTextEncode', inputs: { text: job.pos, clip: ['17', 1] } },
    '11': { class_type: 'CLIPTextEncode', inputs: { text: NEG, clip: ['17', 1] } },
  }
  if (job.kind === 't2i') {
    wf['102'] = { class_type: 'EmptyLatentImage', inputs: { width: W, height: H, batch_size: 1 } }
  } else {
    wf['100'] = { class_type: 'LoadImage', inputs: { image: srcRef } }
    wf['101'] = { class_type: 'ImageScale', inputs: { image: ['100', 0], upscale_method: 'lanczos', width: W, height: H, crop: 'center' } }
    wf['102'] = { class_type: 'VAEEncode', inputs: { pixels: ['101', 0], vae: ['15', 2] } }
  }
  wf['12'] = {
    class_type: 'KSampler',
    inputs: {
      seed: job.seed, steps: STEPS, cfg: CFG, sampler_name: SAMPLER, scheduler: SCHED,
      denoise: job.denoise, model: ['17', 0], positive: ['10', 0], negative: ['11', 0], latent_image: ['102', 0],
    },
  }
  wf['14'] = { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['15', 2] } }
  wf['7'] = { class_type: 'SaveImage', inputs: { images: ['14', 0], filename_prefix: `replica/${RUN}/${job.id}-s${job.seed}` } }
  return wf
}

mkdirSync(OUT, { recursive: true })

async function waitFor(id) {
  const deadline = Date.now() + 600_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    const h = await (await fetch(`${COMFY}/history/${id}`)).json()
    const e = h[id]
    if (!e) continue
    if (e.status?.status_str === 'error') throw new Error(JSON.stringify(e.status).slice(0, 300))
    const imgs = Object.values(e.outputs || {}).flatMap((o) => o.images || [])
    if (!imgs.length) continue
    const im = imgs[0]
    const url = `${COMFY}/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || '')}&type=${im.type || 'output'}`
    return Buffer.from(await (await fetch(url)).arrayBuffer())
  }
  throw new Error('超时 600s')
}

const stats = await fetch(`${COMFY}/system_stats`).then((r) => r.json()).catch(() => null)
if (!stats) throw new Error(`ComfyUI 不可达 ${COMFY}`)
const dev = (stats.devices || [])[0] || {}
const q = await fetch(`${COMFY}/queue`).then((r) => r.json())
console.log(`ComfyUI ${dev.name || '?'}  VRAM free ${(dev.vram_free / 1e9).toFixed(1)}GB  队列 ${(q.queue_running || []).length}+${(q.queue_pending || []).length}`)

const srcRef = await upload(SRC)
console.log(`源图已上传 input/${srcRef}\n`)

const results = []
for (const job of jobs) {
  const tag = `${job.id}-s${job.seed}`
  const dest = join(OUT, `${tag}.png`)
  if (existsSync(dest) && !FORCE) {
    console.log(`skip ${tag}`)
    results.push({ ...job, file: dest, skipped: true })
    continue
  }
  const t0 = Date.now()
  const res = await fetch(`${COMFY}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: buildWorkflow(job, srcRef), client_id: 'lain-replica-ladder' }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`提交失败: ${JSON.stringify(body).slice(0, 300)}`)
  writeFileSync(dest, await waitFor(body.prompt_id))
  const sec = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`✓ ${tag}  ${sec}s  → experiments/runs/${RUN}/ladder/${tag}.png`)
  results.push({ ...job, file: dest })
}

writeFileSync(join(REPO, 'experiments/runs', RUN, 'report.json'), JSON.stringify({ run: RUN, ckpt: CKPT, lora: LORA, loraStrength: LORA_S, source: SRC, size: [W, H], jobs: results.map(({ file, ...r }) => ({ ...r, file: `ladder/${basename(file)}` })) }, null, 2))
console.log(`\n报告 experiments/runs/${RUN}/report.json`)

// contactsheet：横向拼一版，方便人眼扫
const tool = join(REPO, '..', 'tools', 'compare_grid.py')
if (existsSync(tool)) {
  const pngs = results.map((r) => r.file)
  const r = spawnSync('.venv/bin/python', [tool, '--out', join(REPO, 'experiments/runs', RUN, 'contactsheet.png'), '--cols', '4', ...pngs], { cwd: REPO, encoding: 'utf8' })
  if (r.status === 0) console.log('contactsheet 已生成')
  else console.warn('contactsheet 失败（可忽略）：', (r.stderr || '').slice(0, 200))
}
