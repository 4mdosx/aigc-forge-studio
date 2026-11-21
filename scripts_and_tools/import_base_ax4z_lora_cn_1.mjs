#!/usr/bin/env node
// 在 baseline work 下建 base_ax4z_lora_cn_1：ax4z 底模 + LoRA + 双 ControlNet（OpenPose skeleton + Xinsir depth）。
// 图结构克隆自 baseline_v1 当前 head dbv5o9v1（2026-11-21 已归一 ax4z + batch 1）。
//   node scripts_and_tools/import_base_ax4z_lora_cn_1.mjs
//
// 绕行：GET /comfy/workflows 持续报 JSON 污染（userdata 老坑），标准 commit 端点依赖该 GET，
// 故按等价 commit 语义直接写 DB：新 workflow + 新 revision（8 位版本号）+ main 分支 + work 挂载。
// 不改现行 revision，不覆盖；adapter 与新 version 同 key。

import { randomInt, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dbPath = join(repoRoot, 'data', 'runner.sqlite')
const db = new DatabaseSync(dbPath)

const NAME = 'base_ax4z_lora_cn_1'
const SOURCE_VERSION = 'dbv5o9v1'
const CKPT = 'animagine-xl-4.0-zero.safetensors'
const MESSAGE =
  'base_ax4z_lora_cn_1（2026-11-21 token 指定）：克隆 baseline_v1 双 ControlNet 模板（OpenPose skeleton + Xinsir depth），' +
  '底模 animagine-xl-4.0-zero + LoraLoader + batch 1；adapter 暴露 lora_name/lora_strength 直接切风格 LoRA。'

const now = new Date().toISOString()

// --- 读源图 ---
const src = db
  .prepare('SELECT workflow_id, ui_json, api_json FROM workflow_revisions WHERE version = ?')
  .get(SOURCE_VERSION)
if (!src) throw new Error(`source version ${SOURCE_VERSION} not found`)

const ui = JSON.parse(src.ui_json)
const api = JSON.parse(src.api_json)
const nodes = ui.nodes ?? []

const ckpt = nodes.find((n) => n.type === 'CheckpointLoaderSimple')
const loras = nodes.filter((n) => n.type === 'LoraLoader')
const cnApply = nodes.filter((n) => n.type === 'ControlNetApplyAdvanced')
const latent = nodes.find((n) => n.type === 'EmptyLatentImage')
const ks = nodes.find((n) => n.type === 'KSampler')
const save = nodes.find((n) => n.type === 'SaveImage')
if (!ckpt || loras.length !== 1 || cnApply.length !== 2 || !latent || !ks || !save) {
  throw new Error(`源图结构不符预期: ckpt=${!!ckpt} lora=${loras.length} cnApply=${cnApply.length} latent=${!!latent} ks=${!!ks} save=${!!save}`)
}
if (ckpt.widgets_values_named?.ckpt_name !== CKPT) {
  throw new Error(`源图底模不是 ${CKPT}: ${ckpt.widgets_values_named?.ckpt_name}`)
}
if (latent.widgets_values_named?.batch_size !== 1) {
  throw new Error(`源图 batch_size 不是 1: ${latent.widgets_values_named?.batch_size}`)
}
const title = (n) => n.title || n._meta?.title || undefined

// --- 版本号：8 位，字母开头，全库查重 ---
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
let version
for (let i = 0; i < 16; i += 1) {
  let v = LETTERS[randomInt(LETTERS.length)]
  for (let j = 0; j < 7; j += 1) v += ALPHABET[randomInt(ALPHABET.length)]
  if (!db.prepare('SELECT 1 FROM workflow_revisions WHERE version = ?').get(v)) {
    version = v
    break
  }
}
if (!version) throw new Error('版本号分配失败')

const workflowId = randomUUID()
const revisionId = randomUUID()

// adapter：双 CN 全输入 + LoRA 直连入参（不用 step map，那批 style-v1-formal 是 PD 时代产物）
const locator = (n, input, extra = {}) => ({
  class_type: n.type,
  ...(title(n) ? { name: title(n) } : {}),
  input,
  ...extra,
})
const clses = nodes.filter((n) => n.type === 'CLIPTextEncode')
const positiveNode = clses.find((n) => /Positive/i.test(title(n) || '')) ?? clses[0]
const negativeNode = clses.find((n) => /Negative/i.test(title(n) || '')) ?? clses[1]
if (!positiveNode || !negativeNode || positiveNode === negativeNode) {
  throw new Error('Positive/Negative CLIPTextEncode 定位失败')
}
const adapter = {
  inputs: {
    positive: locator(positiveNode, 'text'),
    negative: locator(negativeNode, 'text'),
    pose_image: locator(nodes.find((n) => n.type === 'LoadImage' && /Skeleton/i.test(title(n) || '')), 'image', { upload: true }),
    depth_image: locator(nodes.find((n) => n.type === 'LoadImage' && /Depth/i.test(title(n) || '')), 'image', { upload: true }),
    width: locator(latent, 'width'),
    height: locator(latent, 'height'),
    seed: locator(ks, 'seed'),
    batch: locator(nodes.find((n) => n.type === 'RepeatLatentBatch'), 'amount'),
    denoise: locator(ks, 'denoise'),
    skeleton_strength: locator(cnApply.find((n) => /Skeleton/i.test(title(n) || '')), 'strength'),
    depth_strength: locator(cnApply.find((n) => /Depth/i.test(title(n) || '')), 'strength'),
    lora_name: locator(loras[0], 'lora_name'),
    lora_strength: locator(loras[0], 'strength_model'),
  },
  outputs: { image: locator(save, undefined) },
}
const adapterInputs = adapter.inputs
for (const [key, spec] of Object.entries(adapterInputs)) {
  if (!spec.name && spec.class_type !== 'KSampler') {
    console.warn(`  adapter.${key} 无 name，按 class_type 定位：${spec.class_type}`)
  }
}
const adapterJson = JSON.stringify({ [version]: adapter }, null, 2)

// --- 写入（事务） ---
db.exec('BEGIN')
try {
  db.prepare(
    'INSERT INTO workflows (id, name, comfy_path, current_branch, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(workflowId, NAME, `${NAME}.json`, 'main', now)
  db.prepare(
    'INSERT INTO workflow_revisions (id, workflow_id, version, ui_json, api_json, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(revisionId, workflowId, version, JSON.stringify(ui), JSON.stringify(api), MESSAGE, now)
  db.prepare(
    'INSERT INTO workflow_branches (workflow_id, name, head_revision_id) VALUES (?, ?, ?)',
  ).run(workflowId, 'main', revisionId)
  const work = db.prepare('SELECT id FROM works WHERE name = ?').get('baseline')
  if (!work) throw new Error('baseline work not found')
  db.prepare(
    'INSERT INTO work_workflows (work_id, workflow_id, adapter_json) VALUES (?, ?, ?)',
  ).run(work.id, workflowId, adapterJson)
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  db.close()
  throw err
}
db.close()
console.log(`created workflow ${NAME} version=${version} (source ${SOURCE_VERSION}), mounted under baseline`)
console.log('adapter inputs:', Object.keys(adapter.inputs).join(','))
