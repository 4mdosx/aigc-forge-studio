#!/usr/bin/env node
// 版本矩阵探针：三个 LoRA 版本（正确触发词 / 无触发词 / 无 LoRA）× 任意多组 prompt × 两种通道（纯文生图 / 双 ControlNet）。
// 固定 seed，除「版本」与「prompt」两个维度外全部锁死。
//   node scripts_and_tools/probe_version_matrix.mjs --prompts-file <prompts.json> [--seed 3001,3002]
//        [--lora <file>] [--strength 1.0] [--pose <id>] [--modes t2i,cn] [--out <dir>] [--dry-run]
//
// 三个版本的定义（严格正交，只差一个变量）：
//   trigger   = "<触发词>, <prompt>"   LoRA on   ← v1 vs v2 只差触发词
//   noprefix  = "<prompt>"             LoRA on   ← v2 vs v3 只差 LoRA
//   nolora    = "<prompt>"             LoRA off
// prompt 原样使用：不拼 roll_config 的正向底词、不拼风格词、不加主体模板。
// negative 固定取 roll_config.workflowNegative（纯质量负词，不含人体压制）。
//
// 为什么不走 runner 的 /generate/*：那套不暴露 seed / LoRA 强度 / 版本，且会把
// roll_config 正向词拼在用户 prompt 前面。这里只读 SQLite 取 api_json，改节点后直打 ComfyUI。

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    'prompts-file': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    seed: { type: 'string', default: '3001' },
    lora: { type: 'string', default: 'hemi_real-zxxstyle-seed-az-261121-163.safetensors' },
    trigger: { type: 'string', default: 'zxxstyle' },
    'wrong-trigger': { type: 'string' },
    strength: { type: 'string', default: '1.0' },
    pose: { type: 'string', default: '1794656866008' },
    modes: { type: 'string', default: 't2i,cn' },
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

if (!values['prompts-file']) throw new Error('必须给 --prompts-file')
const PROMPTS = JSON.parse(readFileSync(resolve(values['prompts-file']), 'utf8'))
if (!Array.isArray(PROMPTS) || !PROMPTS.length) throw new Error('prompts 文件必须是非空数组')

const DRY = values['dry-run']
const SEEDS = values.seed.split(',').map((s) => Number(s.trim())).filter(Number.isFinite)
const MODES = values.modes.split(',').map((s) => s.trim()).filter((m) => m === 't2i' || m === 'cn')
const LORA = values.lora.trim()
const TRIGGER = values.trigger.trim()
const STRENGTH = Number(values.strength)
const POSE_ID = values.pose.trim()
const now = new Date()
const DAY = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
const OUTDIR = values.out
  ? resolve(values.out)
  : resolve(REPO, '..', 'experiments', 'runs', `VERSION-MATRIX-${DAY}`)

const VERSIONS = [
  { key: 'trigger', label: `${TRIGGER} + LoRA`, prefix: true, trigger: TRIGGER, strength: STRENGTH },
  { key: 'noprefix', label: '无触发词 + LoRA', prefix: false, strength: STRENGTH },
  { key: 'nolora', label: '无触发词 / LoRA OFF', prefix: false, strength: 0 },
  // 错词对照：证明「差异来自 token 语义」还是「prompt 里多一个词就会重画」。
  ...(values['wrong-trigger']
    ? [
        {
          key: 'wrongtrigger',
          label: `${values['wrong-trigger'].trim()}（错词）+ LoRA`,
          prefix: true,
          trigger: values['wrong-trigger'].trim(),
          strength: STRENGTH,
        },
      ]
    : []),
]

// Danbooru tag 里的括号（bar_(place)）会被 ComfyUI 当权重语法吃掉，必须转义成 \( \)
const escapeTag = (t) => t.replace(/[()[\]]/g, (m) => `\\${m}`)

const json = async (url, init) => {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${JSON.stringify(body).slice(0, 300)}`)
  return body
}

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

function patch(api, { mode, positive, negative, seed, width, height, pose, strength }) {
  must(api, 'CLIPTextEncode', mode === 't2i' ? 'Positive Prompt' : 'Positive').inputs.text = positive
  must(api, 'CLIPTextEncode', mode === 't2i' ? 'Negative Prompt' : 'Negative').inputs.text = negative
  const lora = must(api, 'LoraLoader')
  lora.inputs.lora_name = LORA
  lora.inputs.strength_model = strength
  lora.inputs.strength_clip = strength
  must(api, 'KSampler').inputs.seed = seed
  const latent = must(api, 'EmptyLatentImage', 'Empty Latent')
  latent.inputs.width = width
  latent.inputs.height = height
  latent.inputs.batch_size = 1
  if (mode === 'cn') {
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
  }
  return api
}

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
    const entry = (await fetch(`${COMFY}/history/${id}`).then((r) => r.json()))[id]
    if (entry) {
      if (entry.status?.status_str === 'error')
        throw new Error(`${label}: ComfyUI 执行失败 ${JSON.stringify(entry.status).slice(0, 300)}`)
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
const NEGATIVE = roll.value?.workflowNegative
if (!NEGATIVE) throw new Error('roll_config 缺 workflowNegative')

const loInfo = await json(`${COMFY}/object_info/LoraLoader`)
if (!loInfo.LoraLoader.input.required.lora_name[0].includes(LORA))
  throw new Error(`ComfyUI 看不到 ${LORA}`)

const variant = poseVariant()
const [width, height] = variant.gen
const graphs = {}
for (const m of MODES) graphs[m] = loadGraph(m === 't2i' ? 'baseline_ax4z_lora_v1' : 'base_ax4z_lora_cn_1', HEAD[m])

const promptOf = (p, v) =>
  [v.prefix ? (v.trigger ?? TRIGGER) : '', escapeTag(p.text)].filter(Boolean).join(', ')

if (DRY) {
  console.log(`lora=${LORA} strength=${STRENGTH} trigger=${TRIGGER} seeds=${SEEDS.join(',')}`)
  console.log(`pose=${POSE_ID} ${width}x${height}  modes=${MODES.join(',')}`)
  for (const m of MODES) console.log(`  ${m}@${graphs[m].version}`)
  console.log(`out=${OUTDIR}`)
  for (const p of PROMPTS)
    for (const v of VERSIONS)
      console.log(`  [${p.key}/${v.key}] ${promptOf(p, v).slice(0, 110)}…`)
  console.log(`总张数 ${PROMPTS.length * VERSIONS.length * MODES.length * SEEDS.length}`)
  process.exit(0)
}

const pose = MODES.includes('cn') ? await uploadPose(variant) : null
mkdirSync(OUTDIR, { recursive: true })
console.log(`LoRA ${LORA}  strength=${STRENGTH}  trigger=${TRIGGER}  pose=${POSE_ID} ${width}x${height}`)

const results = []
for (const mode of MODES) {
  const dir = join(OUTDIR, mode)
  mkdirSync(dir, { recursive: true })
  for (const p of PROMPTS) {
    for (const v of VERSIONS) {
      for (const seed of SEEDS) {
        const dst = join(dir, `${p.key}-${v.key}-s${seed}.png`)
        if (existsSync(dst)) {
          console.log(`skip ${mode}/${p.key}/${v.key}/s${seed}`)
          continue
        }
        const positive = promptOf(p, v)
        const api = patch(structuredClone(graphs[mode].api), {
          mode,
          positive,
          negative: NEGATIVE,
          seed,
          width,
          height,
          pose,
          strength: v.strength,
        })
        const image = await runPrompt(api, `${mode}/${p.key}/${v.key}/s${seed}`)
        await download(image, dst)
        results.push({ mode, prompt: p.key, version: v.key, seed, strength: v.strength, positive, file: dst })
        console.log(`${mode}/${p.key}/${v.key}/s${seed} ok`)
      }
    }
  }
}

writeFileSync(
  join(OUTDIR, 'result.json'),
  JSON.stringify(
    {
      lora: LORA,
      strength: STRENGTH,
      trigger: TRIGGER,
      pose: POSE_ID,
      size: [width, height],
      negative: NEGATIVE,
      versions: VERSIONS.map(({ key, label, prefix, strength }) => ({ key, label, prefix, strength })),
      prompts: PROMPTS,
      seeds: SEEDS,
      workflows: Object.fromEntries(MODES.map((m) => [m, graphs[m].version])),
      results,
    },
    null,
    2,
  ),
)

// ---- 拼图：每通道一张，行 = prompt，列 = 三个版本（用第一个 seed）----
const gridSeed = SEEDS[0]
for (const mode of MODES) {
  const dir = join(OUTDIR, mode)
  const cols = VERSIONS.map((v) => v.label).join(',')
  const rows = PROMPTS.map(
    (p) =>
      `${p.label}|${VERSIONS.map((v) => join(dir, `${p.key}-${v.key}-s${gridSeed}.png`)).join('|')}`,
  ).join(';')
  const out = join(dir, `grid-s${gridSeed}.png`)
  const run = spawnSync(
    'python3',
    [
      GRID_TOOL,
      '--out', out,
      '--title', `${LORA.replace('.safetensors', '')} — ${mode === 't2i' ? '纯文生图（无动作控制）' : '双 ControlNet（有动作控制）'} — seed ${gridSeed}`,
      '--cols', cols,
      '--rows', rows,
      '--cell', '400',
    ],
    { cwd: REPO, stdio: 'inherit' },
  )
  if (run.status !== 0) console.warn(`拼图失败 ${mode}: exit ${run.status}`)
  else console.log(`grid -> ${out}`)
}
console.log(`\n${results.length} 张 -> ${OUTDIR}`)
