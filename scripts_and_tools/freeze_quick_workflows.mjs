#!/usr/bin/env node
// 把「快速出图」用的两个工作流换成 2026-11-24 定案的机娘配置。
//
// 快速出图（web/components/quick-generate.tsx）走两条路，工作流名写死在
// runner/src/generate.ts 的 GENERATE_SPECS 里，adapter 也在代码里声明：
//   cn   -> base_ax4z_lora_cn_1   （选 pose，双 ControlNet）
//   base -> baseline_ax4z_lora_v1 （不选 pose，纯文生图）
// 所以这里只换「图的内容」，节点标题必须与 generate.ts 的 adapter 完全一致，
// 否则 applyAdapter 匹配不到节点，任务提交就报 no KSampler named ...。
//
// 定案配置（experiments/runs/FINAL-20261124 + FINALWEAPON-20261124）：
//   animagine-xl-4.0-zero + gloss LoRA 1.0 + struct_pool_v3 LoRA 0.8
//   + openpose 1.0（自绘 COCO-18 骨架）+ depth 0.7（同坐标系合成深度）
//   832x1216 / 30 步 / cfg 5 / euler_ancestral / denoise 1.0
//
// 正面词只保留「画风锁 + 机娘身份」十来 token，把 77 token 预算留给用户在
// 快速出图里自己填盔甲与机设；负面词带全定案里的机娘专用项。
//
// 用法：
//   node scripts_and_tools/freeze_quick_workflows.mjs --dry-run
//   node scripts_and_tools/freeze_quick_workflows.mjs
//   node scripts_and_tools/freeze_quick_workflows.mjs --no-runner

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(scriptDir, '..')

const COMFY = process.env.COMFY_BASE || 'http://192.168.8.136:8188'
const RUNNER = process.env.RUNNER_BASE || 'http://127.0.0.1:8787'
const DRY = process.argv.includes('--dry-run')
const NO_RUNNER = process.argv.includes('--no-runner')

const CKPT = 'animagine-xl-4.0-zero.safetensors'
const GLOSS_LORA = 'gloss_train-gloss-gloss-az-261123-163.safetensors'
const STRUCT_LORA = 'struct_pool_v3-struct-struct-az-261124-042.safetensors'
const CN_POSE = 'openposeSDXL_v10.safetensors'
const CN_DEPTH = 'xinsircontrolnet-depth-sdxl.safetensors'

// 与 generate.ts 的 roll_config 前缀同步维护：改动这里要一起改
// data/runner.sqlite 的 roll_config（见 sync_roll_config.mjs / 本文档）。
const POSITIVE = [
  'masterpiece, best quality, very aesthetic, absurdres',
  'mecha musume, 1girl, solo, full body, pure white seamless background',
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

const POSE_IMAGE = 'mecha_pose_stand-a.png'
const DEPTH_IMAGE = 'mecha_depth_stand-a.png'

// ---------- API -> UI converter（抄自 freeze_mecha_workflow.mjs，勿改） ----------
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
      // 未赋值的纯连线输入（如 ControlNetApplyAdvanced 的可选 vae）不写进 inputs。
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

// ---------- 图 1：cn（选 pose，双 ControlNet） ----------
// 节点标题绑定 generate.ts cnSpec，改标题等于改协议。
export function cnGraph({
  ckpt = CKPT,
  positive = POSITIVE,
  negative = NEGATIVE,
  poseImage = POSE_IMAGE,
  depthImage = DEPTH_IMAGE,
  W = 832,
  H = 1216,
  steps = 30,
  cfg = 5,
  seed = 1001,
  gloss = 1.0,
  struct = 0.8,
  poseStrength = 1.0,
  depthStrength = 0.7,
  prefix = 'character',
} = {}) {
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt }, _title: 'Load Checkpoint' },
    2: {
      class_type: 'LoraLoader',
      inputs: { model: ['1', 0], clip: ['1', 1], lora_name: GLOSS_LORA, strength_model: gloss, strength_clip: gloss },
      _title: 'Style LoRA (strength 0 = off)',
    },
    3: {
      class_type: 'LoraLoader',
      inputs: { model: ['2', 0], clip: ['2', 1], lora_name: STRUCT_LORA, strength_model: struct, strength_clip: struct },
      _title: 'Struct LoRA',
    },
    6: { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['3', 1] }, _title: 'Positive' },
    7: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['3', 1] }, _title: 'Negative' },
    11: { class_type: 'LoadImage', inputs: { image: poseImage }, _title: 'Skeleton Image' },
    25: { class_type: 'LoadImage', inputs: { image: depthImage }, _title: 'Depth Image' },
    16: { class_type: 'ControlNetLoader', inputs: { control_net_name: CN_POSE }, _title: 'OpenPose SDXL ControlNet' },
    17: {
      class_type: 'ControlNetApplyAdvanced',
      inputs: {
        positive: ['6', 0],
        negative: ['7', 0],
        control_net: ['16', 0],
        image: ['11', 0],
        strength: poseStrength,
        start_percent: 0,
        end_percent: 1,
      },
      _title: 'Apply Skeleton Control',
    },
    22: { class_type: 'ControlNetLoader', inputs: { control_net_name: CN_DEPTH }, _title: 'Xinsir Depth SDXL ControlNet' },
    23: {
      class_type: 'ControlNetApplyAdvanced',
      inputs: {
        positive: ['17', 0],
        negative: ['17', 1],
        control_net: ['22', 0],
        image: ['25', 0],
        strength: depthStrength,
        start_percent: 0,
        end_percent: 1,
      },
      _title: 'Apply Depth Control',
    },
    50: { class_type: 'EmptyLatentImage', inputs: { width: W, height: H, batch_size: 1 }, _title: 'Empty Latent' },
    43: { class_type: 'RepeatLatentBatch', inputs: { samples: ['50', 0], amount: 1 }, _title: 'Repeat Latent' },
    4: {
      class_type: 'KSampler',
      inputs: {
        model: ['3', 0],
        seed,
        steps,
        cfg,
        sampler_name: 'euler_ancestral',
        scheduler: 'normal',
        positive: ['23', 0],
        negative: ['23', 1],
        latent_image: ['43', 0],
        denoise: 1,
      },
      _title: 'Base KSampler',
    },
    5: { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['1', 2] }, _title: 'VAE Decode (checkpoint vae)' },
    8: { class_type: 'SaveImage', inputs: { images: ['5', 0], filename_prefix: prefix }, _title: 'Save' },
  }
}

// ---------- 图 2：base（不选 pose，无 ControlNet） ----------
// baseSpec 的 KSampler / SaveImage 不带 name，靠 class_type 唯一匹配 —— 所以这两个
// 节点不能加 _title，且整图各只能有一个。
export function baseGraph({
  ckpt = CKPT,
  positive = POSITIVE,
  negative = NEGATIVE,
  W = 832,
  H = 1216,
  steps = 30,
  cfg = 5,
  seed = 1001,
  gloss = 1.0,
  struct = 0.8,
  prefix = 'character_base',
} = {}) {
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt }, _title: 'Load Checkpoint' },
    2: {
      class_type: 'LoraLoader',
      inputs: { model: ['1', 0], clip: ['1', 1], lora_name: GLOSS_LORA, strength_model: gloss, strength_clip: gloss },
      _title: 'LoRA',
    },
    3: {
      class_type: 'LoraLoader',
      inputs: { model: ['2', 0], clip: ['2', 1], lora_name: STRUCT_LORA, strength_model: struct, strength_clip: struct },
      _title: 'Struct LoRA',
    },
    10: { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['3', 1] }, _title: 'Positive Prompt' },
    11: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['3', 1] }, _title: 'Negative Prompt' },
    13: { class_type: 'EmptyLatentImage', inputs: { width: W, height: H, batch_size: 1 }, _title: 'Empty Latent' },
    12: {
      class_type: 'KSampler',
      inputs: {
        model: ['3', 0],
        seed,
        steps,
        cfg,
        sampler_name: 'euler_ancestral',
        scheduler: 'normal',
        positive: ['10', 0],
        negative: ['11', 0],
        latent_image: ['13', 0],
        denoise: 1,
      },
    },
    7: { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['1', 2] }, _title: 'VAE Decode' },
    8: { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: prefix } },
  }
}

const WORKFLOWS = [
  {
    file: 'base_ax4z_lora_cn_1.json',
    graph: cnGraph,
    id: 'quick-cn-v2',
    extra:
      'Quick generate (pose + dual ControlNet), refrozen 2026-11-24. ' +
      'animagine-xl-4.0-zero + gloss LoRA 1.0 + struct_pool_v3 LoRA 0.8 + openpose 1.0 + depth 0.7. ' +
      'Node titles are bound by runner/src/generate.ts cnSpec - do not rename.',
    message:
      'base_ax4z_lora_cn_1（2026-11-24 换配）：快速出图的 CN 路改为机娘定案配置。' +
      'animagine-xl-4.0-zero + gloss LoRA 1.0（画法）+ struct_pool_v3 LoRA 0.8（机设语言）' +
      ' + openpose 1.0（骨架）+ depth 0.7（同坐标系合成深度）；832x1216 / 30 步 / cfg 5。' +
      '正面词裁到 20 token 左右给用户 prompt 留 77 token 预算；负面词带全机娘专用项（rust/weathering/segmented armor/lineart/cel shading）。' +
      '节点标题与 generate.ts cnSpec 绑定，改名会直接让快速出图提交失败。',
  },
  {
    file: 'baseline_ax4z_lora_v1.json',
    graph: baseGraph,
    id: 'quick-base-v2',
    extra:
      'Quick generate (no pose, no ControlNet), refrozen 2026-11-24. ' +
      'Same stack minus ControlNet. KSampler / SaveImage carry no title: runner baseSpec matches them by class_type.',
    message:
      'baseline_ax4z_lora_v1（2026-11-24 换配）：快速出图的无 CN 路改为机娘定案配置。' +
      'zero + gloss 1.0 + struct_pool_v3 0.8；832x1216 / 30 步 / cfg 5；batch 走 EmptyLatentImage.batch_size。' +
      '注意 KSampler 与 SaveImage 故意不加 title —— generate.ts baseSpec 按 class_type 唯一匹配它们。',
  },
]

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

async function runnerSync(wf) {
  const name = wf.file.replace(/\.json$/, '')
  let sync = await api('/comfy/workflows', {
    method: 'POST',
    body: JSON.stringify({ action: 'import', paths: [wf.file] }),
  })
  if (!sync.ok) throw new Error(`import ${wf.file} failed: ${sync.status} ${JSON.stringify(sync.body)}`)
  let bucket = sync.body.created?.[0] ?? sync.body.updated?.[0] ?? sync.body.unchanged?.[0]
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

  const changed = Boolean(sync.body.created?.[0] || sync.body.updated?.[0])
  console.log(`  runner sync: ${bucket.name} @ ${bucket.version}（${changed ? '有变化' : 'unchanged'}）`)

  let version = bucket.version
  if (changed) {
    const commit = await api(`/workflows/${encodeURIComponent(bucket.name)}/commit`, {
      method: 'POST',
      body: JSON.stringify({ message: wf.message }),
    })
    if (!commit.ok) throw new Error(`commit failed: ${commit.status} ${JSON.stringify(commit.body)}`)
    version = commit.body.version
    console.log(`  commit -> ${version}`)
  }
  return { name, version, changed }
}

async function main() {
  info = await (await fetch(`${COMFY}/object_info`)).json()
  console.log(`ComfyUI ${COMFY}  runner ${RUNNER}  dry=${DRY} noRunner=${NO_RUNNER}`)

  const results = []
  for (const wf of WORKFLOWS) {
    const graph = wf.graph()
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
    results.push(await runnerSync(wf))
  }

  if (results.length) {
    console.log('\n=== runner 结果')
    for (const r of results) console.log(`  ${r.name} @ ${r.version}${r.changed ? '' : '（内容未变）'}`)
  }
  console.log('\ndone')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e)
    process.exit(1)
  })
}
