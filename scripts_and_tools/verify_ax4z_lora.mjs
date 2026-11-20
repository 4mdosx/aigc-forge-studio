#!/usr/bin/env node
// verify_ax4z_lora.mjs — Animagine XL 4.0 Zero + LoRA 验证矩阵。
// 默认（无 --job/--loras）：复现 test-boot 的 4 列矩阵（裸模 / 110 / 220 / 330 step）。
// 由 train_animagine.mjs 调用时：--job <name> --loras <f1,f2,...> --labels <l1,l2,...>
//   自动列 = 裸模 + 每只 LoRA 一列；每列 × 2 场景 × 2 seed，最后按场景出 compare_grid 拼图。
// 走 runner baseline work → baseline_ax4z_lora_v1@<roll_config.version>（无 ControlNet）。
// 正负向取 config/roll_config；--trigger 会给正向词首位置塞入训练时的触发词（keep_tokens=1 必须）。
// 产物：experiments/runs/<out>/<scene>/<col>-s<seed>.png + grid.png + result.json
//
// 用法:
//   node scripts_and_tools/verify_ax4z_lora.mjs [--dry-run] [--only <col>] [--seed 3001]
//   node scripts_and_tools/verify_ax4z_lora.mjs --job <name> --loras <f1,f2> --trigger zzstyle \
//        --out <dir> [--steps-per-epoch 550] [--version ot9sw6zt] [--no-grid]
//
// 前置：ComfyUI :8188 在线；LoRA 已推到 C:\AIGC\models\loras\（train_animagine 自动做）。

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    only: { type: 'string' },
    seed: { type: 'string' },
    job: { type: 'string' },
    loras: { type: 'string' },
    labels: { type: 'string' },
    trigger: { type: 'string', default: '' },
    out: { type: 'string' },
    version: { type: 'string' },
    workflow: { type: 'string', default: 'baseline_ax4z_lora_v1' },
    'steps-per-epoch': { type: 'string', default: '0' },
    'no-grid': { type: 'boolean', default: false },
    strength: { type: 'string', default: '1.0' },
  },
})

const RUNNER = 'http://127.0.0.1:8787'
const COMFY = 'http://192.168.8.136:8188'
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DRY = values['dry-run']
const ONLY = values.only
const SEED_ARG = values.seed
const TRIGGER = values.trigger.trim()
const STRENGTH = Number(values.strength) || 1.0
const STEPS_PER_EPOCH = Number(values['steps-per-epoch']) || 0
const WF = values.workflow || 'baseline_ax4z_lora_v1'
const GRID_TOOL = resolve(REPO, '..', 'tools', 'compare_grid.py')

// 默认 test-boot 矩阵（保持旧命令行为）
const DEFAULT_LORAS = [
  { col: 'base', file: 'None', label: '裸模 Zero' },
  { col: 'l600', file: 'test-boot-az-261119-174-000001.safetensors', label: 'epoch 1 (110 step)' },
  { col: 'l1200', file: 'test-boot-az-261119-174-000002.safetensors', label: 'epoch 2 (220 step)' },
  { col: 'final', file: 'test-boot-az-261119-174.safetensors', label: 'final (330 step)' },
]

function buildLoras() {
  if (!values.loras) return DEFAULT_LORAS.map((l) => ({ ...l }))
  const files = values.loras.split(',').map((s) => s.trim()).filter(Boolean)
  if (!files.length) throw new Error('--loras 为空')
  const labels = values.labels ? values.labels.split(',').map((s) => s.trim()) : []
  return [
    { col: 'base', file: 'None', label: '裸模 Zero' },
    ...files.map((file, i) => ({
      col: i === files.length - 1 ? 'final' : `e${i + 1}`,
      file,
      label: labels[i] || autoLabel(file, i, files.length),
    })),
  ]
}
function autoLabel(file, i, total) {
  if (i === total - 1) return 'final'
  const n = i + 1
  return STEPS_PER_EPOCH ? `epoch ${n} (${STEPS_PER_EPOCH * n} step)` : `epoch ${n}`
}

const LORAS = buildLoras()
const SEEDS = SEED_ARG ? [Number(SEED_ARG)] : [3001, 3002]
const SIZE = { width: 1024, height: 1024 }

const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const OUTDIR = values.out
  ? resolve(values.out)
  : values.job
    ? resolve(REPO, '..', 'experiments', 'runs', `${values.job}-VERIFY-${day}`)
    : resolve(REPO, '..', 'experiments', 'runs', 'AX4Z-LORA-VERIFY-20261120')

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

async function runTask(task, payload, version) {
  const created = await api('/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task, workName: 'baseline', workflowName: WF, version, payload }),
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
    if (Date.now() - start > 600000) throw new Error(`${task} 轮询超时`)
  }
}

async function fetchOutput(taskId, out, dst) {
  const full = out.startsWith('output/') ? out : `output/${out}`
  const res = await fetch(`${RUNNER}/tasks/${taskId}/files/${full}`)
  if (!res.ok) throw new Error(`fetch ${full}: ${res.status}`)
  writeFileSync(dst, Buffer.from(await res.arrayBuffer()))
}

if (DRY) {
  console.log(`work=baseline wf=${WF} size=${SIZE.width}x${SIZE.height} strength=${STRENGTH} trigger="${TRIGGER}"`)
  console.log(`out=${OUTDIR}`)
  for (const l of LORAS) console.log(`  ${l.col.padEnd(6)} ${l.file} (${l.label})`)
  for (const [k, v] of Object.entries(SCENES)) console.log(`  scene ${k}: ${v}`)
  console.log(`seed: ${SEEDS.join(', ')}  total: ${Object.keys(SCENES).length * LORAS.length * SEEDS.length} 张`)
  process.exit(0)
}

// 0. 前置校验：ComfyUI 在线 + checkpoint / LoRA 可见 + settings 词表 + workflow 版本
let positive, negative, VER = values.version || 'ot9sw6zt'
try {
  const cfg = await api('/config/roll_config')
  positive = cfg.value?.workflowPositive
  negative = cfg.value?.workflowNegative
  if (cfg.value?.version && !values.version) VER = cfg.value.version
  if (!positive || !negative) throw new Error('roll_config 缺 workflowPositive/workflowNegative')
} catch (e) { throw new Error(`settings 读取失败: ${e.message}`) }

const ckInfo = await (await fetch(`${COMFY}/object_info/CheckpointLoaderSimple`, { signal: AbortSignal.timeout(8000) })).json().catch(() => null)
if (!ckInfo) throw new Error('ComfyUI 无响应，先启动 :8188')
const ckpts = ckInfo.CheckpointLoaderSimple.input.required.ckpt_name[0]
const hasZero = ckpts.some((n) => n.toLowerCase().includes('animagine-xl-4.0-zero'))
if (!hasZero) throw new Error(`ComfyUI 看不到 animagine-xl-4.0-zero，现有: ${ckpts.slice(0, 8).join(', ')}`)

const loInfo = await (await fetch(`${COMFY}/object_info/LoraLoader`)).json()
const visible = loInfo.LoraLoader.input.required.lora_name[0]
let baseIsNone = visible.includes('None')
if (!baseIsNone) {
  if (!visible.includes(LORAS[1].file)) throw new Error(`LoRA 不可见: ${LORAS[1].file}`)
  LORAS[0].file = LORAS[1].file
}
// base 列无 None 时用 e1 槽 + strength 0 等效裸模；记录进来供拼图标注。
LORAS[0].label = baseIsNone ? '裸模 Zero' : '裸模 Zero (e1@0)'
console.log(`ComfyUI OK：ckpt=${ckpts.filter((n) => n.includes('animagine')).join(', ')}  wf=${WF}@${VER}`)
console.log(`LoRA 可见 ${LORAS.length - 1}/${LORAS.length - 1}${TRIGGER ? `  触发词=${TRIGGER}` : ''}`)

mkdirSync(OUTDIR, { recursive: true })
const results = []
let n = 0
for (const [scene, body] of Object.entries(SCENES)) {
  const dir = join(OUTDIR, scene)
  mkdirSync(dir, { recursive: true })
  for (const l of LORAS) {
    if (ONLY && l.col !== ONLY) continue
    const strength = l.col === 'base' ? 0 : STRENGTH
    for (const seed of SEEDS) {
      const dst = join(dir, `${l.col}-s${seed}.png`)
      if (existsSync(dst)) { console.log(`skip ${scene}/${l.col}/s${seed}`); continue }
      const task = `ax4z-verify-${scene}-${l.col}-s${seed}`
      const payload = {
        positive: [TRIGGER, positive, body].filter(Boolean).join(', '),
        negative,
        width: SIZE.width, height: SIZE.height, batch: 1, seed,
        lora_name: l.file, lora_strength: strength,
      }
      const r = await runTask(task, payload, VER)
      await fetchOutput(r.id, r.out, dst)
      console.log(`${scene}/${l.col}/s${seed} done (strength=${strength})`)
      results.push({ scene, col: l.col, seed, file: l.file, strength, task: r.id })
      n++
    }
  }
}
writeFileSync(join(OUTDIR, 'result.json'), JSON.stringify({
  work: 'baseline', workflow: WF, version: VER, trigger: TRIGGER,
  positive, negative, loras: LORAS, results,
}, null, 2))
console.log(`\n${n} 张 -> ${OUTDIR}`)

// 1. 对比拼图：每场景一张，行 = seed，列 = LoRA 档位
if (!values['no-grid'] && !ONLY) {
  if (!existsSync(GRID_TOOL)) {
    console.warn(`拼图工具缺失：${GRID_TOOL}`)
  } else {
    for (const scene of Object.keys(SCENES)) {
      const dir = join(OUTDIR, scene)
      const cols = LORAS.map((l) => l.label).join(',')
      const rows = SEEDS.map((seed) =>
        `s${seed}|${LORAS.map((l) => join(dir, `${l.col}-s${seed}.png`)).join('|')}`,
      ).join(';')
      const out = join(dir, 'grid.png')
      const run = spawnSync('python3', [
        GRID_TOOL, '--out', out,
        '--title', `${values.job || 'AX4Z LoRA'} 验证 — ${scene}${TRIGGER ? ` (trigger: ${TRIGGER})` : ''}`,
        '--cols', cols, '--rows', rows, '--cell', '420',
      ], { cwd: REPO, stdio: 'inherit' })
      if (run.status !== 0) console.warn(`拼图失败 ${scene}：exit ${run.status}`)
      else console.log(`grid -> ${out}`)
    }
  }
}
