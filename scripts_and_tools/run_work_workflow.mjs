#!/usr/bin/env node
// 从 runner 库里跑一份 workflow：读 work 的 head 版本（UI）+ adapter 映射，
// 本地转成 API graph、注入参数、提交 ComfyUI、回捞图片。
//
// 用途：runner 已删掉 POST /tasks（e251b97），work 的「出图」表单暂时无端点。
// 这个脚本是那条链路的离线等价物——同时用来证明「库里存的这份东西真能跑」。
//
//   node scripts_and_tools/run_work_workflow.mjs --work mecha --workflow mecha_fullbody_v1 \
//     --seed 7301 --pose data/pose/synthetic/stand-a/bone.png --depth data/pose/synthetic/stand-a/depth.png
//
//   --set key=value   覆盖任意 adapter 参数（可重复）
//   --run NAME        产物目录名，默认 RUN-<yyyymmdd-HHMM>
//   --dry-run         只打印最终 prompt，不提交

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(scriptDir, '..')

const COMFY = process.env.COMFY_BASE || 'http://192.168.8.136:8188'
const RUNNER = process.env.RUNNER_BASE || 'http://127.0.0.1:8787'
const DRY = process.argv.includes('--dry-run')

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return def
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : def
}

const WORK = arg('work')
const WORKFLOW = arg('workflow')
const RUN = arg('run', `RUN-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`)
if (!WORK || !WORKFLOW) {
  console.error('缺 --work / --workflow。示例：--work mecha --workflow mecha_fullbody_v1')
  process.exit(1)
}

const OVERRIDES = {}
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] !== '--set') continue
  const raw = process.argv[i + 1]
  if (!raw || raw.startsWith('--')) continue
  const eq = raw.indexOf('=')
  if (eq <= 0) continue
  OVERRIDES[raw.slice(0, eq)] = raw.slice(eq + 1)
}

const info = await (await fetch(`${COMFY}/object_info`)).json()
const SEED_NAMES = new Set(['seed', 'noise_seed'])
const LINK_ONLY_TYPES = new Set([
  'MODEL', 'CLIP', 'VAE', 'LATENT', 'IMAGE', 'MASK', 'CONDITIONING', 'CONTROL_NET', 'IPADAPTER', 'CLIP_VISION',
])

// UI -> API（与 runner/src/comfy/prompt.ts 同序：按 inputs 顺序取 widgets_values）
function fromUI(ui) {
  const linkById = new Map(ui.links.map((l) => [l[0], l]))
  const api = {}
  for (const node of ui.nodes) {
    const def = info[node.type]
    if (!def) throw new Error(`unknown node class ${node.type}`)
    const inputs = {}
    const widgets = node.widgets_values_named
    let wi = 0
    for (const inp of node.inputs) {
      const argName = inp.name
      if (inp.link != null) {
        const l = linkById.get(inp.link)
        inputs[argName] = [String(l[1]), l[2]]
        continue
      }
      const v = widgets?.[argName] ?? node.widgets_values?.[wi]
      if (v !== undefined) inputs[argName] = v
      wi++
      if (SEED_NAMES.has(argName) && typeof v === 'number') wi++
    }
    api[String(node.id)] = { class_type: node.type, inputs, ...(node.title ? { _meta: { title: node.title } } : {}) }
  }
  return api
}

function matchNode(prompt, binding) {
  const found = Object.entries(prompt).filter(([, n]) => n.class_type === binding.class_type)
  const named = binding.name ? found.filter(([, n]) => n._meta?.title === binding.name) : found
  if (named.length !== 1) throw new Error(`${binding.class_type}${binding.name ? ` named ${binding.name}` : ''} matched ${named.length}`)
  return named[0]
}

async function uploadInput(path, target) {
  const abs = resolve(path)
  const buf = readFileSync(abs)
  const ext = extname(abs).toLowerCase()
  const form = new FormData()
  form.append('image', new Blob([buf], { type: ext === '.png' ? 'image/png' : 'image/jpeg' }), target)
  form.append('overwrite', 'true')
  form.append('type', 'input')
  const res = await fetch(`${COMFY}/upload/image`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`上传 ${path} 失败 ${res.status}`)
  const j = await res.json()
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name
}

async function main() {
  const detail = await (await fetch(`${RUNNER}/works/${WORK}`)).json()
  const link = (detail.workflows ?? []).find((w) => w.name === WORKFLOW)
  if (!link) throw new Error(`work ${WORK} 里没有 ${WORKFLOW}`)
  const head = link.versions.find((v) => v.head)
  if (!head) throw new Error(`${WORKFLOW} 没有 head 版本`)
  if (!head.hasAdapter) throw new Error(`${WORKFLOW} @ ${head.version} 没有 adapter`)

  const rev = await (await fetch(`${RUNNER}/workflows/${WORKFLOW}/revisions/${head.version}`)).json()
  const adapter = head.adapter
  if (!adapter) throw new Error('head 版本 adapter 未解析')

  // 参数来源：adapter 默认 → --set 覆盖 → 图上文件走上传
  const values = {}
  const pose = arg('pose')
  const depth = arg('depth')
  if (pose || depth) {
    if (pose) values.pose_image = await uploadInput(pose, `mecha_pose_${basename(pose)}`)
    if (depth) values.depth_image = await uploadInput(depth, `mecha_depth_${basename(depth)}`)
  }
  const seedArg = arg('seed')
  if (seedArg) values.seed = Number(seedArg)
  for (const [k, v] of Object.entries(OVERRIDES)) {
    const numeric = ['width', 'height', 'batch', 'seed', 'step', 'cfg', 'denoise', 'skeleton_strength', 'depth_strength', 'gloss_strength', 'struct_strength']
    values[k] = numeric.includes(k) ? Number(v) : v
  }

  // revision 端点顶层是简化图（节点只剩 id/type/title/xy），完整 UI 在 workflow 字段里
  const ui = rev.workflow ?? rev
  const prompt = fromUI(ui)
  for (const [key, binding] of Object.entries(adapter.inputs)) {
    if (values[key] === undefined) continue
    const [, node] = matchNode(prompt, binding)
    if (!(binding.input in node.inputs)) throw new Error(`node has no input ${binding.input}`)
    node.inputs[binding.input] = values[key]
  }
  for (const key of Object.keys(values)) {
    if (!adapter.inputs[key]) throw new Error(`adapter 没有参数 ${key}`)
  }

  const seed = prompt[Object.keys(prompt).find((id) => prompt[id].class_type === 'KSampler')]?.inputs.seed
  console.log(`work=${WORK} workflow=${WORKFLOW} @${head.version}  seed=${seed}`)
  const seedNode = Object.entries(prompt).find(([, n]) => n.class_type === 'KSampler')
  if (seedNode) seedNode[1].inputs.filename_prefix = `work/${RUN}`

  if (DRY) {
    console.log(JSON.stringify(prompt, null, 1).slice(0, 3000))
    return
  }

  const res = await fetch(`${COMFY}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: `workrun-${RUN}` }),
  })
  if (!res.ok) throw new Error(`提交失败 ${res.status}: ${(await res.text()).slice(0, 400)}`)
  const { prompt_id: pid } = await res.json()
  console.log(`已排队 ${pid}`)

  let out = null
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const h = await fetch(`${COMFY}/history/${pid}`).then((r) => r.json())
    const entry = h[pid]
    if (!entry) continue
    if (entry.status?.status_str === 'error') throw new Error('ComfyUI 报错')
    const imgs = Object.values(entry.outputs || {}).flatMap((o) => o.images || [])
    if (imgs.length) {
      out = imgs[0]
      break
    }
  }
  if (!out) throw new Error('超时没出图')

  const q = new URLSearchParams({ filename: out.filename, subfolder: out.subfolder || '', type: out.type || 'output' })
  const buf = Buffer.from(await (await fetch(`${COMFY}/view?${q}`)).arrayBuffer())
  const dir = join(REPO, 'experiments', 'runs', RUN, 'out')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${WORKFLOW}-${head.version}-s${seed}.png`)
  writeFileSync(file, buf)
  writeFileSync(
    join(REPO, 'experiments', 'runs', RUN, 'manifest.json'),
    JSON.stringify({ work: WORK, workflow: WORKFLOW, version: head.version, values, comfy: out.filename, file }, null, 1),
  )
  console.log(`-> ${file}  ${(buf.length / 1024).toFixed(0)} KB`)
}

main().catch((e) => {
  console.error(e.message || e)
  process.exit(1)
})
