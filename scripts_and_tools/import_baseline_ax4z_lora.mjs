#!/usr/bin/env node
// 在 baseline work 下建 Animagine XL 4.0 Zero + LoRA（无 ControlNet）工作流。
//   node scripts_and_tools/import_baseline_ax4z_lora.mjs
// 源：text2image_sdxl/p2da3xv7（已由 import-workflow-copy 复制为 baseline_ax4z_lora_v1/svwdm8q9）。
// 改图：CheckpointLoaderSimple → animagine-xl-4.0-zero.safetensors；插 LoraLoader（默认旧 LoRA 占位，
// 新训练产物回流后经 adapter 的 lora_name 入参切换）。不改图结构中的任何采样/CN 之外的部分。
//
// 绕行：ComfyUI GET /userdata/<file> 当前环境 404（目录列举正常），
// 故从 runner DB 读完整 ui_json，改完 POST 回 ComfyUI，再走 runner commit。

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const RUNNER = 'http://127.0.0.1:8787'
const COMFY = 'http://192.168.8.136:8188'
const NAME = 'baseline_ax4z_lora_v1'
const VERSION = 'svwdm8q9'
const CKPT = 'animagine-xl-4.0-zero.safetensors'
const LORA_DEFAULT = 'style-v1-formal-000002.safetensors'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(repoRoot, 'data', 'runner.sqlite'), { readOnly: true })
const row = db
  .prepare('SELECT ui_json FROM workflow_revisions WHERE version = ?')
  .get(VERSION)
if (!row) throw new Error(`version ${VERSION} not found in DB`)
db.close()
const doc = JSON.parse(row.ui_json)

const api = async (path, init) => {
  const res = await fetch(`${RUNNER}${path}`, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body).slice(0, 300)}`)
  return body
}

// --- 改图 ---
const ckpt = doc.nodes.find((n) => n.type === 'CheckpointLoaderSimple')
const ks = doc.nodes.find((n) => n.type === 'KSampler')
const cles = doc.nodes.filter((n) => n.type === 'CLIPTextEncode')
if (!ckpt || !ks || cles.length !== 2) throw new Error('源图节点结构不符预期')
if (!Array.isArray(doc.links) || typeof doc.links[0]?.[0] !== 'number') {
  throw new Error('links 不是数组格式')
}

ckpt.widgets_values = [CKPT]
if (ckpt.widgets_values_named && typeof ckpt.widgets_values_named === 'object')
  ckpt.widgets_values_named.ckpt_name = CKPT

const loraId = Math.max(...doc.nodes.map((n) => n.id)) + 1
const lora = {
  id: loraId,
  type: 'LoraLoader',
  title: 'LoRA',
  pos: [900, 120],
  size: [320, 150],
  flags: {},
  order: 3,
  mode: 0,
  inputs: [
    { localized_name: 'model', name: 'model', type: 'MODEL', link: null },
    { localized_name: 'clip', name: 'clip', type: 'CLIP', link: null },
  ],
  outputs: [
    { localized_name: 'MODEL', name: 'MODEL', type: 'MODEL', links: [] },
    { localized_name: 'CLIP', name: 'CLIP', type: 'CLIP', links: [] },
  ],
  properties: { 'Node name for S&R': 'LoraLoader', cnr_id: 'comfy-core', ver: '0.33.0' },
  widgets_values: [LORA_DEFAULT, 0.8, 0.8],
  widgets_values_named: {
    lora_name: LORA_DEFAULT,
    strength_model: 0.8,
    strength_clip: 0.8,
  },
}
doc.nodes.push(lora)

const linkById = (id) => doc.links.find((l) => l[0] === id)
const nextLinkId = () => Math.max(...doc.links.map((l) => l[0])) + 1

// ckpt MODEL 出边（→ KSampler.model）改道进 LoraLoader
const ksModelInput = ks.inputs.find((i) => i.name === 'model')
const modelLink = linkById(ksModelInput.link)
if (!modelLink || modelLink[1] !== ckpt.id) throw new Error('KSampler.model 未直连 ckpt')
modelLink[3] = loraId
modelLink[4] = 0

// ckpt CLIP 原有两条出边（→ 两个 CLE）收成一条进 LoraLoader.clip
const clipLinks = doc.links.filter((l) => l[1] === ckpt.id && l[2] === 1)
if (clipLinks.length !== cles.length) throw new Error(`ckpt CLIP 出边数 ${clipLinks.length} 不符`)
const keepClip = clipLinks[0]
keepClip[3] = loraId
keepClip[4] = 1
const dropClip = clipLinks[1]
doc.links = doc.links.filter((l) => l !== dropClip)

// LoraLoader 输出 → KSampler.model / 两个 CLE.clip
const modelOutLink = nextLinkId()
doc.links.push([modelOutLink, loraId, 0, ks.id, 0])
ksModelInput.link = modelOutLink
for (const cle of cles) {
  const clipInput = cle.inputs.find((i) => i.name === 'clip')
  const via = nextLinkId()
  doc.links.push([via, loraId, 1, cle.id, 0])
  clipInput.link = via
}

// 用最终 links 重建所有节点的 link 引用，避免手工漏改
for (const n of doc.nodes) {
  for (const inp of n.inputs ?? []) inp.link = null
  for (const out of n.outputs ?? []) out.links = []
}
for (const [linkId, from, fromSlot, to, toSlot] of doc.links) {
  const fromNode = doc.nodes.find((n) => n.id === from)
  const toNode = doc.nodes.find((n) => n.id === to)
  if (!fromNode || !toNode) throw new Error(`link ${linkId} 指向不存在的节点`)
  if (!toNode.inputs?.[toSlot]) throw new Error(`link ${linkId} 目标 slot 不存在`)
  if (!fromNode.outputs?.[fromSlot]) throw new Error(`link ${linkId} 源 slot 不存在`)
  toNode.inputs[toSlot].link = linkId
  fromNode.outputs[fromSlot].links.push(linkId)
}

// 确认无 ControlNet 节点
const cnNodes = doc.nodes.filter((n) => /ControlNet/i.test(n.type))
if (cnNodes.length) throw new Error(`仍有 ControlNet 节点: ${cnNodes.map((n) => n.type).join(',')}`)

// --- 写回 ComfyUI ---
// userdata 路径里的 / 必须 encodeURIComponent 成 %2F，否则 404/405。
const userdataPath = encodeURIComponent(`workflows/${NAME}.json`)
const put = await fetch(`${COMFY}/userdata/${userdataPath}?overwrite=true`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(doc),
})
if (!put.ok) throw new Error(`POST userdata ${put.status} ${await put.text()}`)
const check = await fetch(`${COMFY}/userdata/${userdataPath}`)
if (!check.ok) throw new Error(`GET userdata verify ${check.status}`)
const written = await check.json()
if (written.nodes.filter((n) => n.type === 'LoraLoader').length !== 1) {
  throw new Error('写回校验失败：LoraLoader 数量不对')
}
console.log('图已写回 ComfyUI（ckpt=' + CKPT + ', LoraLoader node ' + loraId + '）')

// --- commit 新版本 ---
const committed = await api(`/workflows/${NAME}/commit`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    message:
      'baseline_ax4z_lora_v1（2026-11-20 token 指定）：Animagine XL 4.0 Zero + LoraLoader，无 ControlNet；' +
      '图结构继承 text2image_sdxl，adapter 暴露 lora_name/lora_strength 切训练产物。',
  }),
})
console.log('committed version =', committed.version)

// --- semantic + lora_name + adapter ---
const work = await api('/works/baseline')
await api('/works/baseline/semantic', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    semantic: {
      inputs: {
        ...work.semantic.inputs,
        lora_name: { type: 'string' },
      },
    },
  }),
})

const byName = (type, title) => (n) =>
  n.type === type && (!title || n.title === title)
const positive = doc.nodes.find(byName('CLIPTextEncode', 'Positive Prompt'))
const negative = doc.nodes.find(byName('CLIPTextEncode', 'Negative Prompt'))
const latent = doc.nodes.find(byName('EmptyLatentImage'))
const sampler = doc.nodes.find(byName('KSampler'))
const save = doc.nodes.find(byName('SaveImage'))
if (![positive, negative, latent, sampler, save].every(Boolean)) {
  throw new Error('adapter 目标节点缺失')
}
const ad = await api('/works/baseline/workflows/adapter', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    version: committed.version,
    workflowName: NAME,
    adapter: {
      inputs: {
        positive: { class_type: 'CLIPTextEncode', name: positive.title, input: 'text' },
        negative: { class_type: 'CLIPTextEncode', name: negative.title, input: 'text' },
        width: { class_type: 'EmptyLatentImage', name: latent.title, input: 'width' },
        height: { class_type: 'EmptyLatentImage', name: latent.title, input: 'height' },
        batch: { class_type: 'EmptyLatentImage', name: latent.title, input: 'batch_size' },
        // KSampler / SaveImage 没有 title，name 必须省略（按 class_type 定位）
        seed: { class_type: 'KSampler', input: 'seed' },
        lora_name: { class_type: 'LoraLoader', name: 'LoRA', input: 'lora_name' },
        lora_strength: { class_type: 'LoraLoader', name: 'LoRA', input: 'strength_model' },
      },
      outputs: { images: { class_type: 'SaveImage' } },
    },
  }),
})
console.log('adapter inputs:', Object.keys(ad.adapter.inputs).join(','))
console.log(`\nsettings 用：workflowName=${NAME} version=${committed.version}`)
