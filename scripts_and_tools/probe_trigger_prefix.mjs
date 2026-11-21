#!/usr/bin/env node
// 触发词前缀探针：同一 seed 下只改 prompt 开头的一个 token，看 LoRA 风格是否真被触发词控制。
// 三组变体（zxxstyle / zxstyle / 无触发词）× 两种通道（纯文生图 / 双 ControlNet）× 2 seed。
//   node scripts_and_tools/probe_trigger_prefix.mjs [--dry-run] [--seeds 3001,3002]
//        [--lora <file>] [--strength 1.0] [--pose <id>] [--out <dir>]
//
// 为什么不走 runner 的 /generate/*：那套接口刻意不暴露 seed / LoRA 强度 / 版本，且会把
// roll_config 的正向词拼在用户 prompt 前面——本实验要的恰恰是「触发词在绝对首位 + 固定 seed」。
// 所以这里直接读 SQLite（只读）拿 workflow 的 api_json，本地改节点后打 ComfyUI /prompt。
// 记录只落在 experiments/runs/<...>/result.json，不进 runner 队列。

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    seeds: { type: 'string', default: '3001,3002' },
    lora: { type: 'string', default: 'hemi_real-zxxstyle-seed-az-261121-163.safetensors' },
    strength: { type: 'string', default: '1.0' },
    pose: { type: 'string', default: '1794656866008' },
    out: { type: 'string' },
    't2i-version': { type: 'string' },
    'cn-version': { type: 'string' },
    'skeleton-strength': { type: 'string' },
    'depth-strength': { type: 'string' },
  },
})

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(readFileSync(join(REPO, 'config.json'), 'utf8'))
const RUNNER = `http://127.0.0.1:${config.runner?.port ?? 8787}`
const COMFY = String(config.comfyui?.baseURL ?? 'http://192.168.8.136:8188').replace(/\/$/, '')
const DATA = join(REPO, 'data')
const GRID_TOOL = resolve(REPO, '..', 'tools', 'compare_grid.py')

const DRY = values['dry-run']
const SEEDS = values.seeds.split(',').map((s) => Number(s.trim())).filter(Number.isFinite)
const LORA = values.lora.trim()
const STRENGTH = Number(values.strength)
const POSE_ID = values.pose.trim()
const now = new Date()
const DAY = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
const OUTDIR = values.out
  ? resolve(values.out)
  : resolve(REPO, '..', 'experiments', 'runs', `HEMI-TRIGGER-PROBE-${DAY}`)

// 实验的唯一自变量：prompt 首段。其余（风格词 / 底词 / 主体 / seed / LoRA / 强度）全部锁死。
// loraoff 是对照组：prompt 与 zxxstyle 完全相同，只把 LoRA 强度调到 0——
// 它回答的是「没有 LoRA 时画风差多少」，用来判断「触发词无差异」到底是
// 「LoRA 学得泛」还是「整个 LoRA 就没起作用」。
const VARIANTS = [
  { key: 'loraoff', prefix: 'zxxstyle', label: 'zxxstyle / LoRA OFF', strength: 0 },
  { key: 'none', prefix: '', label: '无触发词' },
  { key: 'zxstyle', prefix: 'zxstyle', label: 'zxstyle（少一个 x）' },
  { key: 'zxxstyle', prefix: 'zxxstyle', label: 'zxxstyle（训练触发词）' },
]
const STYLE_WORDS = 'semi-realistic illustration, painterly rendering'
const BODY =
  '1girl, solo, standing, full body, looking at viewer, simple background, white background, long hair, school uniform'

const json = async (url, init) => {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${JSON.stringify(body).slice(0, 300)}`)
  return body
}

// ---- workflow 图：读只读库，默认取 main head ----
const HEAD = { t2i: values['t2i-version'], cn: values['cn-version'] }
function loadGraph(workflowName, version) {
  const db = new DatabaseSync(join(DATA, 'runner.sqlite'), { readOnly: true })
  const wf = db.prepare('SELECT id FROM workflows WHERE name = ?').get(workflowName)
  if (!wf) throw new Error(`workflow ${workflowName} 不存在`)
  let ver = version
  if (!ver) {
    const branch = db
      .prepare("SELECT head_revision_id FROM workflow_branches WHERE workflow_id = ? AND name = 'main'")
      .get(wf.id)
    ver = db.prepare('SELECT version FROM workflow_revisions WHERE id = ?').get(branch.head_revision_id)
      .version
  }
  const row = db
    .prepare('SELECT api_json FROM workflow_revisions WHERE workflow_id = ? AND version = ?')
    .get(wf.id, ver)
  db.close()
  if (!row) throw new Error(`${workflowName}@${ver} 不存在`)
  return { version: ver, api: JSON.parse(row.api_json) }
}

const find = (api, cls, title) =>
  Object.entries(api).find(([, n]) => n.class_type === cls && (!title || n._meta?.title === title))

function must(api, cls, title) {
  const hit = find(api, cls, title)
  if (!hit) throw new Error(`找不到节点 ${cls}${title ? `「${title}」` : ''}`)
  return hit[1]
}

function patch(api, { mode, positive, negative, seed, width, height, pose, strength = STRENGTH }) {
  must(api, 'CLIPTextEncode', mode === 't2i' ? 'Positive Prompt' : 'Positive').inputs.text = positive
  must(api, 'CLIPTextEncode', mode === 't2i' ? 'Negative Prompt' : 'Negative').inputs.text = negative
  const lora = must(api, 'LoraLoader')
  lora.inputs.lora_name = LORA
  lora.inputs.strength_model = strength
  lora.inputs.strength_clip = strength
  const ks = must(api, 'KSampler')
  ks.inputs.seed = seed
  const latent = must(api, 'EmptyLatentImage', 'Empty Latent')
  latent.inputs.width = width
  latent.inputs.height = height
  if (mode === 'cn') {
    latent.inputs.batch_size = 1
    const repeat = find(api, 'RepeatLatentBatch')
    if (repeat) repeat[1].inputs.amount = 1
    must(api, 'LoadImage', 'Skeleton Image').inputs.image = pose.pose_image
    must(api, 'LoadImage', 'Depth Image').inputs.image = pose.depth_image
    if (values['skeleton-strength'])
      must(api, 'ControlNetApplyAdvanced', 'Apply Skeleton Control').inputs.strength =
        Number(values['skeleton-strength'])
    if (values['depth-strength'])
      must(api, 'ControlNetApplyAdvanced', 'Apply Depth Control').inputs.strength =
        Number(values['depth-strength'])
  } else {
    latent.inputs.batch_size = 1
  }
  return api
}

// ---- 姿态素材：上传到 ComfyUI input/probe/<pose>/ ----
function poseVariant() {
  const manifest = JSON.parse(readFileSync(join(DATA, 'pose', 'manifest.json'), 'utf8'))
  const entry = (manifest.poses ?? []).find((p) => p.id === POSE_ID)
  if (!entry) throw new Error(`pose ${POSE_ID} 不在 manifest`)
  const variant = Object.values(entry.variants ?? {}).find((v) => v?.gen && v?.depth && v?.bone)
  if (!variant) throw new Error(`pose ${POSE_ID} 没有可用 variant`)
  return variant
}

async function uploadPose(variant) {
  const sub = `probe/${POSE_ID}`
  for (const [rel, name] of [
    [variant.bone, 'bone.png'],
    [variant.depth, 'depth.png'],
  ]) {
    const form = new FormData()
    form.append('image', new Blob([readFileSync(join(DATA, rel))]), name)
    form.append('subfolder', sub)
    form.append('type', 'input')
    form.append('overwrite', 'true')
    const res = await fetch(`${COMFY}/upload/image`, { method: 'POST', body: form })
    if (!res.ok) throw new Error(`上传 ${rel}: HTTP ${res.status} ${await res.text()}`)
  }
  return { pose_image: `${sub}/bone.png`, depth_image: `${sub}/depth.png` }
}

async function runPrompt(api, label) {
  const created = await json(`${COMFY}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: api, client_id: randomUUID() }),
  })
  if (created.node_errors && Object.keys(created.node_errors).length) {
    throw new Error(`${label}: node_errors ${JSON.stringify(created.node_errors).slice(0, 400)}`)
  }
  const id = created.prompt_id
  const start = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500))
    const hist = await fetch(`${COMFY}/history/${id}`).then((r) => r.json())
    const entry = hist[id]
    if (entry) {
      if (entry.status?.status_str === 'error') {
        throw new Error(`${label}: ComfyUI 执行失败 ${JSON.stringify(entry.status).slice(0, 300)}`)
      }
      const images = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? [])
      if (!images.length) throw new Error(`${label}: 无输出图`)
      return images[0]
    }
    if (Date.now() - start > 900000) throw new Error(`${label}: 轮询超时`)
  }
}

async function download(image, dst) {
  const q = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder ?? '',
    type: image.type ?? 'output',
  })
  const res = await fetch(`${COMFY}/view?${q}`)
  if (!res.ok) throw new Error(`下载 ${image.filename}: HTTP ${res.status}`)
  writeFileSync(dst, Buffer.from(await res.arrayBuffer()))
}

// ---- 前置校验 ----
const roll = await json(`${RUNNER}/config/roll_config`)
const rollPositive = roll.value?.workflowPositive
const rollNegative = roll.value?.workflowNegative
if (!rollPositive || !rollNegative) throw new Error('roll_config 缺 workflowPositive/workflowNegative')

const loInfo = await json(`${COMFY}/object_info/LoraLoader`)
const visible = loInfo.LoraLoader.input.required.lora_name[0]
if (!visible.includes(LORA)) throw new Error(`ComfyUI 看不到 ${LORA}`)

const variant = poseVariant()
const [width, height] = variant.gen
const t2i = loadGraph('baseline_ax4z_lora_v1', HEAD.t2i)
const cn = loadGraph('base_ax4z_lora_cn_1', HEAD.cn)

const promptOf = (prefix) => [prefix, STYLE_WORDS, rollPositive, BODY].filter(Boolean).join(', ')

if (DRY) {
  console.log(`lora=${LORA} strength=${STRENGTH} seeds=${SEEDS.join(',')}`)
  console.log(`pose=${POSE_ID} ${width}x${height}`)
  console.log(`t2i=baseline_ax4z_lora_v1@${t2i.version}  cn=base_ax4z_lora_cn_1@${cn.version}`)
  console.log(`out=${OUTDIR}`)
  for (const v of VARIANTS) console.log(`  [${v.key}] ${promptOf(v.prefix).slice(0, 120)}…`)
  console.log(`总张数 ${VARIANTS.length * 2 * SEEDS.length}`)
  process.exit(0)
}

const pose = await uploadPose(variant)
mkdirSync(OUTDIR, { recursive: true })
console.log(`LoRA ${LORA}  strength=${STRENGTH}  pose=${POSE_ID} ${width}x${height}`)
console.log(`t2i@${t2i.version}  cn@${cn.version}`)

const results = []
for (const mode of ['t2i', 'cn']) {
  const dir = join(OUTDIR, mode)
  mkdirSync(dir, { recursive: true })
  for (const v of VARIANTS) {
    for (const seed of SEEDS) {
      const dst = join(dir, `${v.key}-s${seed}.png`)
      if (existsSync(dst)) {
        console.log(`skip ${mode}/${v.key}/s${seed}`)
        continue
      }
      const positive = promptOf(v.prefix)
      const api = patch(structuredClone(mode === 't2i' ? t2i.api : cn.api), {
        mode,
        positive,
        negative: rollNegative,
        seed,
        width,
        height,
        pose,
        strength: v.strength ?? STRENGTH,
      })
      const image = await runPrompt(api, `${mode}/${v.key}/s${seed}`)
      await download(image, dst)
      results.push({ mode, variant: v.key, seed, positive, file: dst })
      console.log(`${mode}/${v.key}/s${seed} ok`)
    }
  }
}

writeFileSync(
  join(OUTDIR, 'result.json'),
  JSON.stringify(
    {
      lora: LORA,
      strength: STRENGTH,
      pose: POSE_ID,
      size: [width, height],
      rollPositive,
      rollNegative,
      versions: { t2i: t2i.version, cn: cn.version },
      variants: VARIANTS,
      results,
    },
    null,
    2,
  ),
)

// ---- 拼图：每通道一张，列 = 三组变体，行 = seed ----
for (const mode of ['t2i', 'cn']) {
  const dir = join(OUTDIR, mode)
  const cols = VARIANTS.map((v) => v.label).join(',')
  const rows = SEEDS.map(
    (seed) => `s${seed}|${VARIANTS.map((v) => join(dir, `${v.key}-s${seed}.png`)).join('|')}`,
  ).join(';')
  const out = join(dir, 'grid.png')
  const run = spawnSync(
    'python3',
    [
      GRID_TOOL,
      '--out', out,
      '--title', `${LORA.replace('.safetensors', '')} — ${mode === 't2i' ? '纯文生图' : '双 ControlNet'}`,
      '--cols', cols,
      '--rows', rows,
      '--cell', '420',
    ],
    { cwd: REPO, stdio: 'inherit' },
  )
  if (run.status !== 0) console.warn(`拼图失败 ${mode}: exit ${run.status}`)
  else console.log(`grid -> ${out}`)
}
console.log(`\n${results.length} 张 -> ${OUTDIR}`)
