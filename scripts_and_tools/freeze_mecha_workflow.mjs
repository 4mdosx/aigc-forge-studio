#!/usr/bin/env node
// 冻结机娘全身直出配置：API graph -> ComfyUI UI workflow -> userdata -> runner 库。
//
// 冻结的是 2026-11-24 验证到的那套组合（见 experiments/runs/FINAL-20261124）：
//   animagine-xl-4.0-zero + gloss LoRA 1.0 + struct_pool_v3 LoRA 0.8
//   + openpose 1.0（自绘 COCO-18 骨架）+ depth 0.7（同坐标系合成深度）
//   832x1216 / 30 步 / cfg 5 / euler_ancestral / denoise 1.0
//
// 两条产物：
//   1) ComfyUI: userdata/workflows/<file>.json —— 界面里能直接打开、改、跑
//   2) runner: workflows + workflow_revisions + work 挂载 + adapter 映射
//
// 用法：
//   node scripts_and_tools/freeze_mecha_workflow.mjs            # 全量（ComfyUI + runner）
//   node scripts_and_tools/freeze_mecha_workflow.mjs --dry-run   # 只构建 + 打印，不写
//   node scripts_and_tools/freeze_mecha_workflow.mjs --no-runner # 只写 ComfyUI
//
// 幂等：重复跑会覆盖 ComfyUI 文件（?overwrite=true）；runner 侧已存在的
// workflow 走 action=update 出新 revision，已挂上的 work 不再重复挂。

import { readFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(scriptDir, '..')

const COMFY = process.env.COMFY_BASE || 'http://192.168.8.136:8188'
const RUNNER = process.env.RUNNER_BASE || 'http://127.0.0.1:8787'
const DRY = process.argv.includes('--dry-run')
const NO_RUNNER = process.argv.includes('--no-runner')

const GLOSS_LORA = 'gloss_train-gloss-gloss-az-261123-163.safetensors'
const STRUCT_LORA = 'struct_pool_v3-struct-struct-az-261124-042.safetensors'
const CN_POSE = 'openposeSDXL_v10.safetensors'
const CN_DEPTH = 'xinsircontrolnet-depth-sdxl.safetensors'

const POSITIVE = [
  'masterpiece, best quality, very aesthetic, absurdres, mecha musume, 1girl, solo',
  'standing, full body, looking at viewer, pure white seamless background',
  'heavy white armor, large pauldrons, armored gauntlets, armored boots, mechanical wings',
  'black glossy bodysuit, gold mechanical joints, glowing cyan accents',
].join(', ')

const NEGATIVE = [
  'lineart, cel shading, flat colors, hard black outline, sketch, monochrome, watercolor',
  'rust, weathering, matte, segmented armor, muddy',
  'lowres, worst quality, low quality, jpeg artifacts',
  'bad anatomy, bad hands, extra fingers, missing fingers, extra limbs, fused legs',
  'mutated hands, deformed, cropped, feet out of frame',
  'text, signature, watermark, logo, busy background, scenery, colored background',
  'multiple girls, nude, nsfw, chibi',
].join(', ')

// ---------- 骨架 / 深度配对资源 ----------
// 自绘 COCO-18 骨架（pose_synth.py）与同坐标系 depth（pose_depth_synth.py）必须成对，
// 单独换其中一张会把构图拽歪。默认上传 stand-a（正面直立，已验证 8/8 全身入画）。
const POSE_VARIANTS = ['stand-a', 'stand-3q', 'stand-hands', 'stand-hip', 'stand-open']
const DEFAULT_VARIANT = 'stand-a'
const poseAsset = (v) => `mecha_pose_${v}.png`
const depthAsset = (v) => `mecha_depth_${v}.png`

// ---------- API -> UI converter（抄自 experiments/cutin_video/freeze_video_workflows.mjs，勿改） ----------
function isLink(v) {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1]) && /^\d+$/.test(v[0])
}

const SEED_NAMES = new Set(['seed', 'noise_seed'])
const LINK_ONLY_TYPES = new Set([
  'MODEL', 'CLIP', 'VAE', 'LATENT', 'IMAGE', 'MASK', 'CONDITIONING', 'CONTROL_NET', 'IPADAPTER', 'CLIP_VISION',
])

let info = {}

function toUI(apiNodes, opts = {}) {
  const idNum = (s) => Number(s)
  const nodeIds = Object.keys(apiNodes).map(idNum).sort((a, b) => a - b)
  const links = []
  let nextLink = 1

  const linkByTarget = new Map()
  for (const id of nodeIds) {
    const nd = apiNodes[String(id)]
    for (const [arg, v] of Object.entries(nd.inputs || {})) {
      if (!isLink(v)) continue
      const [srcId, srcSlot] = [Number(v[0]), v[1]]
      const srcClass = apiNodes[v[0]]?.class_type
      const outNames = info[srcClass]?.output_name || info[srcClass]?.output || []
      const type = outNames[srcSlot] || 'unknown'
      const linkId = nextLink++
      links.push([linkId, srcId, srcSlot, id, 0, type])
      linkByTarget.set(`${id}:${arg}`, linkId)
    }
  }

  const nodes = []
  let order = 0
  for (const id of nodeIds) {
    const nd = apiNodes[String(id)]
    const def = info[nd.class_type]
    if (!def) throw new Error(`unknown node class: ${nd.class_type}`)
    const req = Object.keys(def.input.required || {})
    const opt = Object.keys(def.input.optional || {})
    const argOrder = [...req, ...opt]
    const inputs = []
    const widgets = []
    // runner 的 promptFromUi 只认 widgets_values_named（取值真相源），
    // ComfyUI 前端只认 widgets_values（位置数组）——两者必须同写。
    const named = {}
    let targetSlot = 0

    for (const arg of argOrder) {
      const v = nd.inputs?.[arg]
      const spec = (def.input.required || {})[arg] || (def.input.optional || {})[arg]
      const specType = Array.isArray(spec) ? spec[0] : spec
      const linked = isLink(v)
      // 未赋值的纯连线输入（如 ControlNetApplyAdvanced 的可选 vae）不写进 inputs：
      // runner 的 promptFromUi 会把无 link 的 input 当 widget 查 widgets_values_named，
      // 而这类输入本来就没有 widget 值。上游转换器也是这么跳的。
      if (!linked && v === undefined && typeof specType === 'string' && LINK_ONLY_TYPES.has(specType)) continue
      const linkId = linked ? linkByTarget.get(`${id}:${arg}`) : null
      if (linked) {
        const l = links.find((x) => x[0] === linkId)
        if (l) l[3] = targetSlot
      }
      const uiInput = {
        name: arg,
        type: Array.isArray(specType) ? specType : String(specType),
        link: linkId ?? null,
      }
      if (Array.isArray(specType)) uiInput.widget = { name: arg }
      inputs.push(uiInput)
      targetSlot++

      if (!linked && v !== undefined) {
        widgets.push(v)
        named[arg] = v
        if (SEED_NAMES.has(arg) && typeof v === 'number') widgets.push('fixed')
      }
    }

    const outNames = def.output_name || def.output || []
    const outputs = outNames.map((name, i) => ({
      name,
      type: (def.output || [])[i] || name,
      links: links.filter((l) => l[1] === id && l[2] === i).map((l) => l[0]),
    }))

    nodes.push({
      id,
      type: nd.class_type,
      title: nd._title || undefined,
      pos: opts.pos ? opts.pos(id, nd) : [60 + (order % 5) * 340, 60 + Math.floor(order / 5) * 420],
      size: [300, 140],
      flags: {},
      order: order++,
      mode: 0,
      inputs,
      outputs,
      properties: { 'Node name for S&R': nd.class_type },
      widgets_values: widgets,
      widgets_values_named: named,
    })
  }

  return {
    id: opts.id,
    revision: 0,
    last_node_id: Math.max(...nodeIds),
    last_link_id: links.length,
    nodes,
    links,
    groups: [],
    config: {},
    extra: { info: opts.extra || '' },
    version: 0.4,
  }
}

function fromUI(ui) {
  const linkById = new Map(ui.links.map((l) => [l[0], l]))
  const api = {}
  for (const node of ui.nodes) {
    const def = info[node.type]
    const argOrder = [...Object.keys(def.input.required || {}), ...Object.keys(def.input.optional || {})]
    const inputs = {}
    let wi = 0
    for (let i = 0; i < node.inputs.length; i++) {
      const inp = node.inputs[i]
      // 用 input.name 而不是 argOrder[i]：toUI 会跳过未赋值的纯连线输入，位置会错位。
      const arg = inp.name ?? argOrder[i]
      if (inp.link != null) {
        const l = linkById.get(inp.link)
        inputs[arg] = [String(l[1]), l[2]]
        continue
      }
      const spec = (def.input.required || {})[arg] || (def.input.optional || {})[arg]
      const st = Array.isArray(spec) ? spec[0] : spec
      if (typeof st === 'string' && LINK_ONLY_TYPES.has(st)) continue
      inputs[arg] = node.widgets_values[wi++]
      if (SEED_NAMES.has(arg) && typeof inputs[arg] === 'number') wi++
    }
    api[String(node.id)] = { class_type: node.type, inputs }
  }
  return api
}

function assertRoundTrip(apiGraph, ui) {
  const norm = (o) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(o).map(([k, v]) => [
          k,
          {
            class_type: v.class_type,
            inputs: Object.fromEntries(
              Object.entries(v.inputs || {}).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)),
            ),
          },
        ]),
      ),
    )
  const a = norm(apiGraph)
  const b = norm(fromUI(ui))
  if (a !== b) {
    throw new Error(`UI->API roundtrip mismatch\n  original: ${a.slice(0, 900)}\n  roundtrip: ${b.slice(0, 900)}`)
  }
  console.log('  ROUNDTRIP OK')
}

// ---------- 图 ----------
function mechaGraph({
  ckpt = 'animagine-xl-4.0-zero.safetensors',
  positive = POSITIVE,
  negative = NEGATIVE,
  poseImage = poseAsset(DEFAULT_VARIANT),
  depthImage = depthAsset(DEFAULT_VARIANT),
  W = 832,
  H = 1216,
  steps = 30,
  cfg = 5,
  seed = 7301,
  gloss = 1.0,
  struct = 0.8,
  poseStrength = 1.0,
  depthStrength = 0.7,
  prefix = 'mecha_fullbody',
} = {}) {
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt }, _title: 'Checkpoint' },
    2: {
      class_type: 'LoraLoader',
      inputs: { model: ['1', 0], clip: ['1', 1], lora_name: GLOSS_LORA, strength_model: gloss, strength_clip: gloss },
      _title: 'Gloss LoRA',
    },
    3: {
      class_type: 'LoraLoader',
      inputs: { model: ['2', 0], clip: ['2', 1], lora_name: STRUCT_LORA, strength_model: struct, strength_clip: struct },
      _title: 'Struct LoRA',
    },
    4: { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['3', 1] }, _title: 'Positive' },
    5: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['3', 1] }, _title: 'Negative' },
    11: { class_type: 'LoadImage', inputs: { image: poseImage }, _title: 'Skeleton Image' },
    12: { class_type: 'LoadImage', inputs: { image: depthImage }, _title: 'Depth Image' },
    13: { class_type: 'ControlNetLoader', inputs: { control_net_name: CN_POSE }, _title: 'OpenPose Loader' },
    14: {
      class_type: 'ControlNetApplyAdvanced',
      inputs: {
        positive: ['4', 0],
        negative: ['5', 0],
        control_net: ['13', 0],
        image: ['11', 0],
        strength: poseStrength,
        start_percent: 0,
        end_percent: 1,
      },
      _title: 'Pose Control',
    },
    15: { class_type: 'ControlNetLoader', inputs: { control_net_name: CN_DEPTH }, _title: 'Depth Loader' },
    16: {
      class_type: 'ControlNetApplyAdvanced',
      inputs: {
        positive: ['14', 0],
        negative: ['14', 1],
        control_net: ['15', 0],
        image: ['12', 0],
        strength: depthStrength,
        start_percent: 0,
        end_percent: 1,
      },
      _title: 'Depth Control',
    },
    17: { class_type: 'EmptyLatentImage', inputs: { width: W, height: H, batch_size: 1 }, _title: 'Latent' },
    6: {
      class_type: 'KSampler',
      inputs: {
        model: ['3', 0],
        seed,
        steps,
        cfg,
        sampler_name: 'euler_ancestral',
        scheduler: 'normal',
        positive: ['16', 0],
        negative: ['16', 1],
        latent_image: ['17', 0],
        denoise: 1,
      },
      _title: 'Sampler',
    },
    7: { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] }, _title: 'Decode' },
    8: { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: prefix }, _title: 'Save' },
  }
}

// ---------- adapter ----------
const node = (type, name, input) => ({ class_type: type, name, input })

const ADAPTER = {
  inputs: {
    positive: node('CLIPTextEncode', 'Positive', 'text'),
    negative: node('CLIPTextEncode', 'Negative', 'text'),
    pose_image: { ...node('LoadImage', 'Skeleton Image', 'image'), upload: true },
    depth_image: { ...node('LoadImage', 'Depth Image', 'image'), upload: true },
    width: node('EmptyLatentImage', 'Latent', 'width'),
    height: node('EmptyLatentImage', 'Latent', 'height'),
    batch: node('EmptyLatentImage', 'Latent', 'batch_size'),
    seed: node('KSampler', 'Sampler', 'seed'),
    step: node('KSampler', 'Sampler', 'steps'),
    cfg: node('KSampler', 'Sampler', 'cfg'),
    denoise: node('KSampler', 'Sampler', 'denoise'),
    skeleton_strength: node('ControlNetApplyAdvanced', 'Pose Control', 'strength'),
    depth_strength: node('ControlNetApplyAdvanced', 'Depth Control', 'strength'),
    gloss_strength: node('LoraLoader', 'Gloss LoRA', 'strength_model'),
    struct_strength: node('LoraLoader', 'Struct LoRA', 'strength_model'),
  },
  outputs: { image: { class_type: 'SaveImage', name: 'Save' } },
}

const FIELD_TYPES = {
  positive: 'string',
  negative: 'string',
  pose_image: 'image',
  depth_image: 'image',
  seed: 'seed',
}

const SEMANTIC = {
  inputs: Object.fromEntries(
    Object.keys(ADAPTER.inputs).map((key) => [key, { type: FIELD_TYPES[key] ?? 'string' }]),
  ),
}

const WORKFLOWS = [
  {
    work: 'mecha',
    file: 'mecha_fullbody_v1.json',
    id: 'mecha-fullbody-v1',
    extra:
      'Mecha musume full-body straight-out generation, frozen 2026-11-24. ' +
      'animagine-xl-4.0-zero + gloss LoRA (painterly gloss) + struct_pool_v3 LoRA (design language) ' +
      '+ openpose 1.0 on self-drawn COCO-18 skeleton + depth 0.7 on same-coordinate synthetic depth. ' +
      'pose/depth images MUST come as a pair (stand-a / stand-3q / stand-hands / stand-hip / stand-open). ' +
      'Depth is what pins feet inside the canvas (8/8 full body vs 1/3 without). ' +
      'Do not lower depth below 0.6: 0.5 is worse than none (half-interference).',
    message:
      'mecha_fullbody_v1（2026-11-24 冻结）：机娘全身直出主配置。' +
      'animagine-xl-4.0-zero + gloss LoRA 1.0（画法/质感）+ struct_pool_v3 LoRA 0.8（设计语言：机械四肢/分件/比例）' +
      ' + openpose 1.0（自绘 COCO-18 骨架，非 pose 库） + depth 0.7（同坐标系合成深度）。' +
      '832x1216 / 30 步 / cfg 5 / euler_ancestral / denoise 1.0。' +
      '骨架与深度必须成对使用：depth 占满画布高度、骨架留 10% 底部留白，靠 depth 把脚钉在画面内。' +
      '验证：8 seed 全身入画 8/8，底部边界 0.852-0.857；struct v3 相对 v1 的 mechanical_legs 1/6→5/6、robot_joints 1/6→4/6。' +
      '已知限制：zero 基模出浅灰底（prompt 写 pure white 无效），人物偏瘦长（depth 0.7 + full body 的副作用）。',
  },
]

// ---------- ComfyUI 交互 ----------
async function uploadInput(path, target) {
  const abs = resolve(REPO, path)
  const buf = readFileSync(abs)
  const ext = extname(abs).toLowerCase()
  const form = new FormData()
  form.append('image', new Blob([buf], { type: ext === '.png' ? 'image/png' : 'image/jpeg' }), target)
  form.append('overwrite', 'true')
  form.append('type', 'input')
  const res = await fetch(`${COMFY}/upload/image`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`upload ${path} -> ${res.status}`)
  const j = await res.json()
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name
}

async function uploadPosePairs() {
  const out = []
  for (const v of POSE_VARIANTS) {
    const pose = await uploadInput(`data/pose/synthetic/${v}/bone.png`, poseAsset(v))
    const depth = await uploadInput(`data/pose/synthetic/${v}/depth.png`, depthAsset(v))
    out.push({ variant: v, pose, depth })
    console.log(`  ${v}: input/${pose} + input/${depth}`)
  }
  return out
}

// ---------- runner 交互 ----------
async function api(path, init) {
  const res = await fetch(`${RUNNER}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { ok: res.ok, status: res.status, body }
}

async function runnerImport(wf) {
  // 不走 GET /comfy/workflows（要对目录里所有文件做 storedStatus，任何一个坏文件就把整个
  // 接口拖成 500）。只针对本文件：先 import；已入库且内容变化时 runner 会拒，改走 update。
  // 内容有变化（created / updated）后再 commit 一次，让新版本带上说明。
  const name = wf.file.replace(/\.json$/, '')
  let version = null
  let changed = false

  let sync = await api('/comfy/workflows', {
    method: 'POST',
    body: JSON.stringify({ action: 'import', paths: [wf.file] }),
  })
  if (!sync.ok) throw new Error(`import ${wf.file} failed: ${sync.status} ${JSON.stringify(sync.body)}`)
  let bucket = sync.body.created?.[0] ?? sync.body.unchanged?.[0]
  let failure = sync.body.failed?.[0]

  if (!bucket && failure && /覆盖/.test(failure.error ?? '')) {
    sync = await api('/comfy/workflows', {
      method: 'POST',
      body: JSON.stringify({ action: 'update', paths: [wf.file] }),
    })
    if (!sync.ok) throw new Error(`update ${wf.file} failed: ${sync.status} ${JSON.stringify(sync.body)}`)
    bucket = sync.body.updated?.[0] ?? sync.body.unchanged?.[0]
    failure = sync.body.failed?.[0]
  }

  if (!bucket) throw new Error(`sync ${wf.file} 失败：${JSON.stringify(failure ?? sync.body)}`)

  version = bucket.version
  changed = Boolean(sync.body.created?.[0] || sync.body.updated?.[0])
  console.log(`  runner sync: ${bucket.name} @ ${version}（${changed ? '有变化' : 'unchanged'}）`)

  if (changed) {
    const commit = await api(`/workflows/${encodeURIComponent(bucket.name)}/commit`, {
      method: 'POST',
      body: JSON.stringify({ message: wf.message }),
    })
    if (!commit.ok) throw new Error(`commit failed: ${commit.status} ${JSON.stringify(commit.body)}`)
    version = commit.body.version
    console.log(`  commit -> ${version}`)
  }

  const works = await api('/works')
  const workExists = (works.body.works ?? []).some((w) => w.name === wf.work)
  if (!workExists) {
    const created = await api('/works', {
      method: 'POST',
      body: JSON.stringify({ name: wf.work, semantic: SEMANTIC }),
    })
    if (!created.ok) throw new Error(`create work failed: ${created.status} ${JSON.stringify(created.body)}`)
    console.log(`  work ${wf.work} 已创建`)
  } else {
    await api(`/works/${wf.work}/semantic`, { method: 'POST', body: JSON.stringify({ semantic: SEMANTIC }) })
    console.log(`  work ${wf.work} 已存在，semantic 同步`)
  }

  const detail = await api(`/works/${wf.work}`)
  const bound = (detail.body.workflows ?? []).some((w) => w.name === name)
  if (!bound) {
    const attached = await api(`/works/${wf.work}/workflows`, {
      method: 'POST',
      body: JSON.stringify({ workflowName: name }),
    })
    if (!attached.ok) throw new Error(`attach failed: ${attached.status} ${JSON.stringify(attached.body)}`)
    console.log(`  已挂到 work ${wf.work}`)
  }

  const after = await api(`/works/${wf.work}`)
  const link = (after.body.workflows ?? []).find((w) => w.name === name)
  if (!version) version = link?.versions?.find((v) => v.head)?.version
  if (!version) throw new Error(`拿不到 ${name} 的 head 版本`)

  const saved = await api(`/works/${wf.work}/workflows/adapter`, {
    method: 'POST',
    body: JSON.stringify({ workflowName: name, version, adapter: ADAPTER }),
  })
  if (!saved.ok) throw new Error(`save adapter failed: ${saved.status} ${JSON.stringify(saved.body)}`)

  const check = await api(`/works/${wf.work}`)
  const finalLink = (check.body.workflows ?? []).find((w) => w.name === name)
  const head = finalLink?.versions?.find((v) => v.version === version)
  const fit = head?.adapterStatus
  const status = typeof fit === 'string' ? fit : (fit?.status ?? 'unknown')
  return { name, version, adapterStatus: status, error: fit?.error ?? null }
}

// ---------- main ----------
async function main() {
  info = await (await fetch(`${COMFY}/object_info`)).json()
  console.log(`ComfyUI ${COMFY}  runner ${RUNNER}  dry=${DRY} noRunner=${NO_RUNNER}`)

  console.log('\n=== 上传骨架/深度配对资源')
  if (DRY) console.log('  (dry-run 跳过)')
  else await uploadPosePairs()

  const results = []
  for (const wf of WORKFLOWS) {
    const graph = mechaGraph()
    const ui = toUI(graph, { id: wf.id, extra: wf.extra })
    console.log(`\n=== ${wf.file}: ${ui.nodes.length} nodes, ${ui.links.length} links`)
    assertRoundTrip(graph, ui)

    if (!DRY) {
      const res = await fetch(`${COMFY}/userdata/workflows%2F${wf.file}?overwrite=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(ui),
      })
      const text = await res.text()
      console.log(`  userdata HTTP ${res.status}: ${text.slice(0, 120)}`)
      if (!res.ok) throw new Error(`写入 ${wf.file} 失败`)

      const back = await (await fetch(`${COMFY}/userdata/workflows%2F${wf.file}`)).text()
      const parsed = JSON.parse(back)
      console.log(`  读回校验: nodes=${parsed.nodes?.length ?? 0} bytes=${back.length}`)
      if (!parsed.nodes?.length) throw new Error('读回为空')
    }

    if (DRY || NO_RUNNER) continue
    results.push({ file: wf.file, work: wf.work, ...(await runnerImport(wf)) })
  }

  if (results.length) {
    console.log('\n=== runner 结果')
    for (const r of results) {
      console.log(`  ${r.name} @ ${r.version}  adapter=${r.adapterStatus}${r.error ? ` (${r.error})` : ''}`)
    }
    const bad = results.filter((r) => r.adapterStatus !== 'ready')
    if (bad.length) process.exitCode = 1
  }
  console.log('\ndone')
}

main().catch((e) => {
  console.error(e.message || e)
  process.exit(1)
})
