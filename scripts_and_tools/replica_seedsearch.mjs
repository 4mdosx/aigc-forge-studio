#!/usr/bin/env node
// replica_seedsearch.mjs — 文生图能不能「碰」出训练集里的那一张（2026-11-23）
//
// 命题：训练集某张参考图 x*，能不能靠 T2I 直接生成出来？
// 做法：拿 x* 自己的 caption 当 prompt，扫一堆 seed，看 best-of-N 能贴到多近。
//       同时对比「训练时的完整 caption」和「人手写的几个 tag」两种 prompt，
//       因为训练/推理的 caption 长度分布不匹配本身就是一大损耗。
//
// 用法：
//   node scripts_and_tools/replica_seedsearch.mjs --dry
//   node scripts_and_tools/replica_seedsearch.mjs --run SEEDSEARCH-20261123 --seeds 32

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
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

const RUN = arg('run', 'SEEDSEARCH')
const DRY = flag('dry')
const FORCE = flag('force')
const CKPT = arg('ckpt', 'animagine-xl-4.0-zero.safetensors')
const LORA = arg('lora', 'ohou19-ohou-ohou-style-az-261122-140.safetensors')
const LORA_S = Number(arg('lora-strength', '1.0'))
const STEPS = Number(arg('steps', '30'))
const CFG = Number(arg('cfg', '6'))
const SAMPLER = arg('sampler', 'dpmpp_2m')
const SCHED = arg('scheduler', 'karras')
const N = Number(arg('seeds', '32'))
const SEED_BASE = Number(arg('seed-base', '1'))
const TARGET = resolve(arg('target', join(REPO, 'data/training-export/ohou19/img/20261122-001117-1b38.png')))
const [W, H] = arg('size', '1216x688').split('x').map(Number)
const ONLY = arg('modes', 'user,full').split(',').map((s) => s.trim()).filter(Boolean)
const OUT = join(REPO, 'experiments/runs', RUN, 'seedsearch')

const NEG = 'lineart, cel shading, flat colors, outline, sketch, lowres, worst quality, low quality, bad anatomy, bad hands, extra fingers, text, signature, watermark, logo, multiple girls, chibi, 2d, flat lighting'

// 人写的短 prompt（用户真实用法）
const USER_POS = '1girl, playboy bunny, rabbit ears, black highleg leotard, black pantyhose, black gloves, high heels, long multicolored hair, full body, looking at viewer'

// 训练时配的完整 caption，一字不动。超 75 token 会被 CLIP 截断，
// 但截断点是模型和 tokenizer 决定的，跟训练时同一套逻辑，所以原样喂最准。
const FULL_POS = readFileSync(TARGET.replace(/\.\w+$/, '.txt'), 'utf8').trim()

const PROMPTS = { user: USER_POS, full: FULL_POS }

// 额外 prompt 变体，可重复：--extra NAME=文本 或 --extra NAME=@/path/to/file.txt
// 用途（2026-11-23）：概念解耦实验 —— 同一份 caption 去掉某一段风格词，
// 看 LoRA 是否把 `rim light` 和 `crimson and black` 学成了两个独立概念，
// 还是学成了一个不可拆的合并词。
{
  const extras = []
  process.argv.forEach((a, i) => {
    if (a === '--extra' && process.argv[i + 1]) extras.push(process.argv[i + 1])
  })
  for (const s of extras) {
    const k = s.indexOf('=')
    if (k < 0) throw new Error(`--extra 需要 NAME=VALUE 形式：${s}`)
    const name = s.slice(0, k)
    const raw = s.slice(k + 1)
    PROMPTS[name] = raw.startsWith('@')
      ? readFileSync(raw.slice(1), 'utf8').trim()
      : raw
  }
}

const modes = ONLY.filter((m) => PROMPTS[m])

console.log(`目标 ${basename(TARGET)} → ${W}x${H} | LoRA w${LORA_S} | ${N} seeds × ${modes.length} 种 prompt`)
for (const m of modes) console.log(`  ${m}: ${PROMPTS[m].length} 字符, ${PROMPTS[m].split(',').length} 段`)
console.log(`  提示：训练 caption 约 ${Math.round(FULL_POS.length / 4)} token 量级，CLIP 上限 75，尾部会被静默截断`)

const jobs = []
for (const m of modes) {
  for (let i = 0; i < N; i++) jobs.push({ mode: m, seed: SEED_BASE + i, pos: PROMPTS[m] })
}
if (DRY) {
  console.log(`\n--dry：共 ${jobs.length} 张，不提交。`)
  process.exit(0)
}

function buildWorkflow(job) {
  return {
    '15': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
    '17': { class_type: 'LoraLoader', inputs: { lora_name: LORA, strength_model: LORA_S, strength_clip: LORA_S, model: ['15', 0], clip: ['15', 1] } },
    '10': { class_type: 'CLIPTextEncode', inputs: { text: job.pos, clip: ['17', 1] } },
    '11': { class_type: 'CLIPTextEncode', inputs: { text: NEG, clip: ['17', 1] } },
    '102': { class_type: 'EmptyLatentImage', inputs: { width: W, height: H, batch_size: 1 } },
    '12': { class_type: 'KSampler', inputs: { seed: job.seed, steps: STEPS, cfg: CFG, sampler_name: SAMPLER, scheduler: SCHED, denoise: 1.0, model: ['17', 0], positive: ['10', 0], negative: ['11', 0], latent_image: ['102', 0] } },
    '14': { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['15', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['14', 0], filename_prefix: `seedsearch/${RUN}/${job.mode}-s${job.seed}` } },
  }
}

async function waitFor(id) {
  const deadline = Date.now() + 600_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200))
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

mkdirSync(OUT, { recursive: true })
const st = await fetch(`${COMFY}/system_stats`).then((r) => r.json()).catch(() => null)
if (!st) throw new Error(`ComfyUI 不可达 ${COMFY}`)
const dev = (st.devices || [])[0] || {}
console.log(`ComfyUI ${dev.name || '?'}  VRAM free ${(dev.vram_free / 1e9).toFixed(1)}GB\n`)

const results = []
for (const job of jobs) {
  const tag = `${job.mode}-s${job.seed}`
  const dest = join(OUT, `${tag}.png`)
  if (existsSync(dest) && !FORCE) {
    results.push({ tag })
    continue
  }
  const t0 = Date.now()
  const res = await fetch(`${COMFY}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: buildWorkflow(job), client_id: 'lain-seedsearch' }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`提交失败 ${tag}: ${JSON.stringify(body).slice(0, 300)}`)
  writeFileSync(dest, await waitFor(body.prompt_id))
  console.log(`✓ ${tag}  ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  results.push({ tag, file: `seedsearch/${tag}.png` })
}

writeFileSync(join(REPO, 'experiments/runs', RUN, 'seedsearch-report.json'), JSON.stringify({ run: RUN, target: TARGET, size: [W, H], lora: LORA, loraStrength: LORA_S, prompts: modes.map((m) => ({ mode: m, text: PROMPTS[m] })), results }, null, 2))
console.log(`\n报告 experiments/runs/${RUN}/seedsearch-report.json`)
