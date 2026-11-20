#!/usr/bin/env node
// verify_ax4z_lora.mjs — Animagine XL 4.0 Zero + test-boot LoRA 验证矩阵（2026-11-20）
// 4 列（裸模 / 600 步 / 1200 步 / final 330 步）× 2 场景 × 2 seed = 16 张。
// 走 runner baseline work → baseline_ax4z_lora_v1@y4jl7y4f（无 ControlNet）。
// 正负向取 config/roll_config 的 Animagine 官方推荐词；lora_name/lora_strength 由 adapter 注入。
// 产物：experiments/runs/AX4Z-LORA-VERIFY-20261120/<scene>/<col>-s<seed>.png
//
// 用法: node scripts_and_tools/verify_ax4z_lora.mjs [--dry-run] [--only <col>] [--seed 3001]
//
// 前置：ComfyUI :8188 在线；三个 LoRA 已推到 C:\AIGC\models\loras\（train_animagine 流程）。

import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNNER = 'http://127.0.0.1:8787'
const COMFY = 'http://192.168.8.136:8188'
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTDIR = resolve(REPO, '../experiments/runs/AX4Z-LORA-VERIFY-20261120')
const WORK = 'baseline'
const WF = 'baseline_ax4z_lora_v1'
const VER = 'y4jl7y4f'

const args = process.argv.slice(2)
const argOf = (k, d) => { const i = args.indexOf(`--${k}`); return i > 0 ? args[i + 1] : d }
const DRY = args.includes('--dry-run')
const ONLY = argOf('only')
const SEED_ARG = argOf('seed')

// LoraLoader 需要一个合法的名字；"None" 是 ComfyUI 内建空槽（探测确认），
// 若无则用首只 LoRA + strength 0 等效裸模。
const LORAS = [
  { col: 'base', file: 'None', label: '裸模 Zero' },
  { col: 'l600', file: 'test-boot-az-261119-174-000001.safetensors', label: 'epoch 1 (110 step)' },
  { col: 'l1200', file: 'test-boot-az-261119-174-000002.safetensors', label: 'epoch 2 (220 step)' },
  { col: 'final', file: 'test-boot-az-261119-174.safetensors', label: 'final (330 step)' },
]
const SEEDS = SEED_ARG ? [Number(SEED_ARG)] : [3001, 3002]
const STRENGTH = 1.0
const SIZE = { width: 1024, height: 1024 }

const SCENES = {
  // 场景 A：无装备词，看 LoRA 是否自发带入靴子/机娘先验
  plain: '1girl, solo, standing, full body, looking at viewer, simple background, white background, long hair, school uniform',
  // 场景 B：明确靴子词，看 LoRA 对指定装备的强化与形变为何
  boots: '1girl, solo, standing, full body, looking at viewer, simple background, white background, long hair, thigh high boots, armored boots, mechanical boots, futuristic armor',
}

const api = async (path, init) => {
  const res = await fetch(`${RUNNER}${path}`, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body).slice(0, 300)}`)
  return body
}

async function runTask(task, payload) {
  const created = await api('/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task, workName: WORK, workflowName: WF, version: VER, payload }),
  })
  if (created.error) throw new Error(`${task}: ${created.error}`)
  const start = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000))
    const t = await api(`/tasks/${created.id}`)
    if (['completed', 'failed', 'cancelled'].includes(t.status)) {
      if (t.status !== 'completed') throw new Error(`${task}: ${t.status} ${t.error ?? ''}`)
      let outs = t.outputPath ?? '[]'
      if (typeof outs === 'string') { try { outs = JSON.parse(outs) } catch { outs = [outs] } }
      if (!Array.isArray(outs)) outs = [outs]
      if (!outs.length) outs = (t.process ?? []).map((p) => p.path).filter(Boolean)
      if (!outs.length) throw new Error(`${task}: 无产物`)
      return { id: created.id, out: outs[0] }
    }
    if (Date.now() - start > 300000) throw new Error(`${task} 轮询超时`)
  }
}

async function fetchOutput(taskId, out, dst) {
  const full = out.startsWith('output/') ? out : `output/${out}`
  const res = await fetch(`${RUNNER}/tasks/${taskId}/files/${full}`)
  if (!res.ok) throw new Error(`fetch ${full}: ${res.status}`)
  writeFileSync(dst, Buffer.from(await res.arrayBuffer()))
}

if (DRY) {
  console.log(`work=${WORK} wf=${WF}@${VER} size=${SIZE.width}x${SIZE.height} strength=${STRENGTH}`)
  for (const l of LORAS) console.log(`  ${l.col.padEnd(6)} ${l.file} (${l.label})`)
  for (const [k, v] of Object.entries(SCENES)) console.log(`  scene ${k}: ${v}`)
  console.log(`seed: ${SEEDS.join(', ')}  total: ${Object.keys(SCENES).length * LORAS.length * SEEDS.length} 张`)
  process.exit(0)
}

// 0. 前置校验：ComfyUI 在线 + checkpoint / LoRA 可见 + settings 词表
let positive, negative
try {
  const cfg = await api('/config/roll_config')
  positive = cfg.value?.workflowPositive
  negative = cfg.value?.workflowNegative
  if (!positive || !negative) throw new Error('roll_config 缺 workflowPositive/workflowNegative')
} catch (e) { throw new Error(`settings 读取失败: ${e.message}`) }

const ckInfo = await (await fetch(`${COMFY}/object_info/CheckpointLoaderSimple`, { signal: AbortSignal.timeout(8000) })).json().catch(() => null)
if (!ckInfo) throw new Error('ComfyUI 无响应，先启动 :8188')
const ckpts = ckInfo.CheckpointLoaderSimple.input.required.ckpt_name[0]
const hasZero = ckpts.some((n) => n.toLowerCase().includes('animagine-xl-4.0-zero'))
if (!hasZero) throw new Error(`ComfyUI 看不到 animagine-xl-4.0-zero，现有: ${ckpts.slice(0, 8).join(', ')}`)

const loInfo = await (await fetch(`${COMFY}/object_info/LoraLoader`)).json()
const visible = loInfo.LoraLoader.input.required.lora_name[0]
let baseFile = 'None'
if (!visible.includes('None')) {
  baseFile = LORAS[1].file
  if (!visible.includes(baseFile)) throw new Error(`LoRA 不可见: ${baseFile}`)
  LORAS[0].file = baseFile
}
console.log(`ComfyUI OK：ckpt=${ckpts.filter((n) => n.includes('animagine')).join(', ')}`)
console.log(`LoRA 可见 ${visible.filter((n) => n.includes('test-boot')).length}/3，裸模槽=${LORAS[0].file}`)

mkdirSync(OUTDIR, { recursive: true })
const results = []
let n = 0
for (const [scene, body] of Object.entries(SCENES)) {
  const dir = join(OUTDIR, scene)
  mkdirSync(dir, { recursive: true })
  for (const l of LORAS) {
    if (ONLY && l.col !== ONLY) continue
    const strength = l.col === 'base' && LORAS[0].file === 'None' ? 0 : STRENGTH
    for (const seed of SEEDS) {
      const dst = join(dir, `${l.col}-s${seed}.png`)
      if (existsSync(dst)) { console.log(`skip ${scene}/${l.col}/s${seed}`); continue }
      const task = `ax4z-verify-${scene}-${l.col}-s${seed}`
      const payload = {
        positive: `${positive}, ${body}`,
        negative,
        width: SIZE.width, height: SIZE.height, batch: 1, seed,
        lora_name: l.file, lora_strength: strength,
      }
      const r = await runTask(task, payload)
      await fetchOutput(r.id, r.out, dst)
      console.log(`${scene}/${l.col}/s${seed} done (strength=${strength})`)
      results.push({ scene, col: l.col, seed, file: l.file, strength, task: r.id })
      n++
    }
  }
}
writeFileSync(join(OUTDIR, 'result.json'), JSON.stringify({ work: WORK, workflow: WF, version: VER, positive, negative, results }, null, 2))
console.log(`\n${n} 张 -> ${OUTDIR}`)
