#!/usr/bin/env node
// replica_sharpen.mjs — 「涂抹感 / 精度低 / 手指崩」的归因阶梯（2026-11-23）
//
// 问题现象（ohou19cap2 LoRA，1216x688 直出，30 步 cfg6 dpmpp_2m karras w1.0）：
//   笔触涂抹感强、细节密度低于参考图、人物出现多只手。
//
// 做四个单独变量的对照，每个变量只动一处：
//   base      复现问题（同一 seed 必须能重现同一张）
//   s40sde    步数 30→40，采样器 dpmpp_2m→dpmpp_2m_sde
//   lora075   LoRA 权重 1.0→0.75（少注入训练集的柔和边）
//   neg       负面加 blurry/smudge/deformed hands 等（cfg6 下负面有效）
//   hires     两段式：1216x688 直出 → latent 放大 1.4x → denoise 0.45 重绘
//
// 用法：
//   node scripts_and_tools/replica_sharpen.mjs --dry
//   node scripts_and_tools/replica_sharpen.mjs --run SHARPEN-20261123 --only base,neg
//   node scripts_and_tools/replica_sharpen.mjs --run SHARPEN-20261123 --cases s40sde,lora075,neg,hires

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const COMFY = process.env.COMFY_URL || 'http://192.168.8.136:8188'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  if (i === -1) return d
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) throw new Error(`--${n} 缺值`)
  return v
}
const flag = (n) => process.argv.includes(`--${n}`)
const RUN = arg('run', 'SHARPEN')
const DRY = flag('dry')
const FORCE = flag('force')

const CKPT = 'animagine-xl-4.0-zero.safetensors'
const LORA = arg('lora', 'ohou19cap2-ohou-ohou-style-az-261122-183.safetensors')
const TARGET = resolve(arg('target', join(REPO, 'data/training-export/ohou19cap2/img/20261122-001117-1b38.png')))
const [W, H] = arg('size', '1216x688').split('x').map(Number)
const SEEDS = arg('seeds', '5,8,12,14').split(',').map(Number)
const UPSCALE = Number(arg('upscale', '1.4'))
const HIRES_DENOISE = Number(arg('hires-denoise', '0.45'))
const ONLY = arg('cases', arg('only', 'base,s40sde,lora075,neg,hires')).split(',').map((s) => s.trim()).filter(Boolean)
const OUT = join(REPO, 'experiments/runs', RUN, 'sharpen')

const POS = readFileSync(TARGET.replace(/\.\w+$/, '.txt'), 'utf8').trim()

const NEG_BASE =
  'lineart, cel shading, flat colors, outline, sketch, lowres, worst quality, low quality, bad anatomy, bad hands, extra fingers, text, signature, watermark, logo, multiple girls, chibi, 2d, flat lighting'

// 只加「明确描述画面缺陷」的词，不加风格词（风格词会把 LoRA 的质感顶掉）
const NEG_SHARP = `${NEG_BASE}, blurry, blur, smeared, smudge, low detail, oversmoothed, jpeg artifacts, extra arms, extra hands, mutated hands, deformed hands, fused fingers, missing fingers, disfigured`

const CASES = {
  base: { steps: 30, sampler: 'dpmpp_2m', sched: 'karras', lora: 1.0, neg: NEG_BASE, hires: false },
  s40sde: { steps: 40, sampler: 'dpmpp_2m_sde', sched: 'karras', lora: 1.0, neg: NEG_BASE, hires: false },
  lora075: { steps: 30, sampler: 'dpmpp_2m', sched: 'karras', lora: 0.75, neg: NEG_BASE, hires: false },
  neg: { steps: 30, sampler: 'dpmpp_2m', sched: 'karras', lora: 1.0, neg: NEG_SHARP, hires: false },
  hires: { steps: 30, sampler: 'dpmpp_2m', sched: 'karras', lora: 1.0, neg: NEG_BASE, hires: true },
  hiresneg: { steps: 30, sampler: 'dpmpp_2m', sched: 'karras', lora: 1.0, neg: NEG_SHARP, hires: true },
  hires40: { steps: 40, sampler: 'dpmpp_2m_sde', sched: 'karras', lora: 1.0, neg: NEG_BASE, hires: true },
}

const unknown = ONLY.filter((c) => !CASES[c])
if (unknown.length) throw new Error(`未知 case: ${unknown.join(',')}；可选 ${Object.keys(CASES).join(',')}`)

console.log(`prompt ${POS.split(',').length} 段 ${POS.length} 字符 | ${W}x${H} | LoRA ${LORA}`)
console.log(`seeds ${SEEDS.join(',')} | cases ${ONLY.join(',')}`)
if (CASES.hires && ONLY.includes('hires')) console.log(`hires ${UPSCALE}x → ${Math.round(W * UPSCALE)}x${Math.round(H * UPSCALE)} denoise ${HIRES_DENOISE}`)
if (DRY) {
  console.log(`\n--dry：共 ${ONLY.length * SEEDS.length} 张，不提交。`)
  process.exit(0)
}

function build(job) {
  const c = CASES[job.case]
  const base = {
    '15': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
    '17': { class_type: 'LoraLoader', inputs: { lora_name: LORA, strength_model: c.lora, strength_clip: c.lora, model: ['15', 0], clip: ['15', 1] } },
    '10': { class_type: 'CLIPTextEncode', inputs: { text: POS, clip: ['17', 1] } },
    '11': { class_type: 'CLIPTextEncode', inputs: { text: c.neg, clip: ['17', 1] } },
    '102': { class_type: 'EmptyLatentImage', inputs: { width: W, height: H, batch_size: 1 } },
    '12': {
      class_type: 'KSampler',
      inputs: { seed: job.seed, steps: c.steps, cfg: 6, sampler_name: c.sampler, scheduler: c.sched, denoise: 1.0, model: ['17', 0], positive: ['10', 0], negative: ['11', 0], latent_image: ['102', 0] },
    },
  }
  if (!c.hires) {
    return {
      ...base,
      '14': { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['15', 2] } },
      '7': { class_type: 'SaveImage', inputs: { images: ['14', 0], filename_prefix: `sharpen/${RUN}/${job.case}-s${job.seed}` } },
    }
  }
  // 两段式：pass1 直出 → latent 放大 → pass2 低 denoise 重绘细节
  const uw = Math.round((W * UPSCALE) / 8) * 8
  const uh = Math.round((H * UPSCALE) / 8) * 8
  return {
    ...base,
    '20': { class_type: 'LatentUpscale', inputs: { upscale_method: 'bislerp', width: uw, height: uh, crop: 'disabled', samples: ['12', 0] } },
    '21': {
      class_type: 'KSampler',
      inputs: { seed: job.seed, steps: 28, cfg: 6, sampler_name: c.sampler, scheduler: c.sched, denoise: HIRES_DENOISE, model: ['17', 0], positive: ['10', 0], negative: ['11', 0], latent_image: ['20', 0] },
    },
    '14': { class_type: 'VAEDecode', inputs: { samples: ['21', 0], vae: ['15', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['14', 0], filename_prefix: `sharpen/${RUN}/${job.case}-s${job.seed}` } },
  }
}

async function waitFor(id) {
  const deadline = Date.now() + 900_000
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
  throw new Error('超时 900s')
}

mkdirSync(OUT, { recursive: true })
const st = await fetch(`${COMFY}/system_stats`).then((r) => r.json()).catch(() => null)
if (!st) throw new Error(`ComfyUI 不可达 ${COMFY}`)
const dev = (st.devices || [])[0] || {}
console.log(`ComfyUI ${dev.name || '?'}  VRAM free ${(dev.vram_free / 1e9).toFixed(1)}GB\n`)

const results = []
for (const c of ONLY) {
  for (const seed of SEEDS) {
    const tag = `${c}-s${seed}`
    const dest = join(OUT, `${tag}.png`)
    if (existsSync(dest) && !FORCE) {
      console.log(`· ${tag} 已存在，跳过`)
      results.push({ tag, file: `sharpen/${tag}.png` })
      continue
    }
    const t0 = Date.now()
    const res = await fetch(`${COMFY}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: build({ case: c, seed }), client_id: 'lain-sharpen' }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(`提交失败 ${tag}: ${JSON.stringify(body).slice(0, 400)}`)
    writeFileSync(dest, await waitFor(body.prompt_id))
    console.log(`✓ ${tag}  ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    results.push({ tag, file: `sharpen/${tag}.png` })
  }
}

writeFileSync(
  join(REPO, 'experiments/runs', RUN, 'sharpen-report.json'),
  JSON.stringify({ run: RUN, target: TARGET, size: [W, H], lora: LORA, prompt: POS, cases: ONLY.map((c) => ({ id: c, ...CASES[c] })), upscale: UPSCALE, hiresDenoise: HIRES_DENOISE, seeds: SEEDS, results }, null, 2),
)
console.log(`\n完成 ${results.length} 张 → ${OUT}`)
