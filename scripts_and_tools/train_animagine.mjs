#!/usr/bin/env node
// 把导出的数据集推到训练机，并以 Animagine XL 4.0 Zero 为底模启动 LoRA 训练。
//   node scripts_and_tools/train_animagine.mjs --dry-run                       # 只看参数，不动服务
//   node scripts_and_tools/train_animagine.mjs --list-profiles                # 列出全部 profile
//   node scripts_and_tools/train_animagine.mjs --dataset style-fullbody --profile seed --trigger zzstyle
//   node scripts_and_tools/train_animagine.mjs --dataset style-fullbody --profile refine-r1 --set unetLr=0.0002
//
// 数据源：data/training-export/<dataset>/img（由 export_dataset.mjs 产出）。
// 落点：训练机 C:\AIGC\training\<dataset>\img，底模 C:\AIGC\models\checkpoints\animagine-xl-4.0-zero.safetensors。
// 训练参数：profile 只写与 runner STABLE_PRESET 的差异项；runner 会 merge（{...preset, ...body}）。
// 建 job 必须走 runner :8787 自动吃快档（TE cache 开 / shuffle 关，2.0~2.6 s/it）；
// 直连 trainer :8788 会吃到原始慢档（~14.5 s/it）。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    dataset: { type: 'string' },
    profile: { type: 'string', default: 'seed' },
    trigger: { type: 'string', default: '' },
    set: { type: 'string', multiple: true, default: [] },
    'dry-run': { type: 'boolean', default: false },
    'list-profiles': { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '4' },
  },
})

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const config = JSON.parse(readFileSync(join(repoRoot, 'config.json'), 'utf8'))
const trainerBase = String(
  config.runner?.trainerBaseURL ?? 'http://192.168.8.136:8788',
).replace(/\/$/, '')
const runnerBase = `http://127.0.0.1:${config.runner?.port ?? 8787}`
const BASE_MODEL = 'checkpoints/animagine-xl-4.0-zero.safetensors'

const profilesDoc = JSON.parse(
  readFileSync(join(scriptDir, 'train_profiles.json'), 'utf8'),
)
const profiles = profilesDoc.profiles

// trainer/src/train/toml.ts 接受的训练字段。白名单挡拼写错误，避免静默吃掉覆盖。
const ALLOWED_PARAMS = [
  'resolution',
  'batchSize',
  'numRepeats',
  'networkDim',
  'networkAlpha',
  'unetLr',
  'textEncoderLr',
  'scheduler',
  'lrWarmupSteps',
  'maxTrainEpochs',
  'saveEveryNEpochs',
  'clipSkip',
  'minSnrGamma',
  'sdpa',
  'unetOnly',
  'sdxl',
  'cacheTextEncoderOutputs',
  'shuffleCaption',
  'keepTokens',
  'samplePrompts',
  'sampleEveryNEpochs',
]

function coerce(raw) {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw !== '' && Number.isFinite(Number(raw))) return Number(raw)
  return raw
}

if (values['list-profiles']) {
  console.log('训练 profile（train_profiles.json）——只列差异项，其余继承 runner STABLE_PRESET\n')
  for (const [name, p] of Object.entries(profiles)) {
    console.log(`  ${name.padEnd(11)} ${p.desc}`)
    console.log(`  ${' '.repeat(11)} ${Object.entries(p.params).map(([k, v]) => `${k}=${v}`).join('  ')}\n`)
  }
  console.log('用法：--profile <name> [--set key=value ...] [--trigger <word>] [--dry-run]')
  process.exit(0)
}

const profile = profiles[values.profile]
if (!profile) {
  console.error(
    `未知 profile: ${values.profile}\n可用：${Object.keys(profiles).join(', ')}\n用 --list-profiles 看详情。`,
  )
  process.exit(1)
}

const overrides = {}
for (const item of values.set) {
  const i = item.indexOf('=')
  if (i < 1) {
    console.error(`--set 格式要 key=value，收到: ${item}`)
    process.exit(1)
  }
  const key = item.slice(0, i).trim()
  if (!ALLOWED_PARAMS.includes(key)) {
    console.error(`未知训练参数: ${key}\n可用：${ALLOWED_PARAMS.join(', ')}`)
    process.exit(1)
  }
  overrides[key] = coerce(item.slice(i + 1).trim())
}
const params = { ...profile.params, ...overrides }
// 触发词传了就锁住 caption 首个 token；没传时尊重 profile 的设置。
if (values.trigger.trim()) params.keepTokens = 1
// runner preset 默认 cacheTextEncoderOutputs=true，必须把继承值算进互斥检查。
if ((params.cacheTextEncoderOutputs ?? true) && (params.shuffleCaption ?? false)) {
  console.error(
    'cacheTextEncoderOutputs 与 shuffleCaption 互斥（trainer 会拒绝）。' +
      'runner 快档默认 cache=on；要开 shuffle 得同时 --set cacheTextEncoderOutputs=false。',
  )
  process.exit(1)
}

if (!values.dataset) {
  console.error('需要 --dataset <名字>（export_dataset.mjs 导出的目录名）')
  process.exit(1)
}
const dirName = values.dataset.replace(/[^\w.-]+/g, '-')
const imageDir = join(repoRoot, 'data', 'training-export', dirName, 'img')
try {
  statSync(imageDir)
} catch {
  console.error(`没有导出目录：${imageDir}\n先跑 export_dataset.mjs`)
  process.exit(1)
}

const images = readdirSync(imageDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
const pairs = images
  .map((image) => {
    const stem = image.replace(/\.[^.]+$/, '')
    const caption = join(imageDir, `${stem}.txt`)
    return existsFile(caption) ? { image, stem, caption } : null
  })
  .filter(Boolean)
function existsFile(p) {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}
if (pairs.length === 0) {
  console.error(`没有带 caption 的图片：${imageDir}`)
  process.exit(1)
}

const repeats = params.numRepeats ?? 10
const epochs = params.maxTrainEpochs ?? 3
const steps = pairs.length * repeats * epochs
const [lo, hi] = profile.expectImages ?? []
if (pairs.length < lo || pairs.length > hi) {
  console.warn(
    `警告：profile ${values.profile} 预期 ${lo}-${hi} 图，实际 ${pairs.length} 图。用错 profile 会改变曝光密度。`,
  )
}
console.log(`profile  ${values.profile} — ${profile.desc}`)
console.log(`数据集  ${dirName}：${pairs.length}/${images.length} 组 image+caption`)
console.log('参数覆盖（其余继承 runner STABLE_PRESET）：')
for (const [k, v] of Object.entries(params)) console.log(`  ${k.padEnd(26)} ${v}`)
if (Object.keys(overrides).length) {
  console.log(`--set 覆盖：${Object.keys(overrides).join(', ')}`)
}
console.log(
  `估算  ${pairs.length} 图 × ${repeats} repeats × ${epochs} epochs = ${steps} step` +
    `（@2s/it ≈ ${Math.round(steps * 2 / 60)} min）`,
)
if (values['dry-run']) {
  console.log('\n[dry-run] 未上传、未建 job。去掉 --dry-run 即启动。')
  process.exit(0)
}

// 底模检查：下载未完成时给出明确提示，别让训练 job 在启动后才失败。
const downloads = await fetchJson('/downloads')
const modelDownloads = downloads.downloads.filter(
  (d) => d.root === 'models' && d.path === BASE_MODEL,
)
// 同一 path 可能留下 cancelled 的旧任务（换下载源时），优先认 completed。
const modelDownload =
  modelDownloads.find((d) => d.status === 'completed') ?? modelDownloads.at(-1)
if (modelDownload?.status === 'failed') {
  console.error(`底模下载失败：${modelDownload.error}`)
  process.exit(1)
}
if (!modelDownload || modelDownload.status !== 'completed') {
  console.warn(
    `警告：底模下载状态 ${modelDownload?.status ?? '未提交'}，训练可能启动失败。`,
  )
}

const concurrency = Math.max(1, Number(values.concurrency) || 4)
// /upload 的 path 相对 root，不带 root 名（带 training/ 会落到 training\training）
const target = `${dirName}/img`
console.log(`\n推送 ${pairs.length} 组 → ${trainerBase}`)
let done = 0
const errors = []
async function upload(path, bytes) {
  const url = `${trainerBase}/upload?root=training&path=${encodeURIComponent(path)}`
  const res = await fetch(url, { method: 'POST', body: bytes })
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`)
}
const workers = Array.from({ length: Math.min(concurrency, pairs.length) }, async (_, i) => {
  for (let n = i; n < pairs.length; n += concurrency) {
    const p = pairs[n]
    try {
      await upload(`${target}/${p.image}`, readFileSync(join(imageDir, p.image)))
      await upload(`${target}/${p.stem}.txt`, readFileSync(p.caption))
      done += 1
      if (done % 5 === 0) console.log(`  ${done}/${pairs.length}`)
    } catch (err) {
      errors.push(err.message)
      console.error(`FAIL ${err.message}`)
    }
  }
})
await Promise.all(workers)
if (errors.length) {
  console.error(`${errors.length} 个文件上传失败`)
  process.exit(1)
}
console.log(`已推 ${done} 组到 ${target}`)

const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(2, 12).replace('T', '-')
const name = `${dirName}-${values.profile}-az-${stamp}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
const body = {
  name,
  datasetRoot: 'training',
  datasetPath: `${dirName}/img`,
  baseModel: BASE_MODEL,
  ...params,
}
const { job } = await fetchJson(`${runnerBase}/train/jobs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
console.log(`\n训练 job：${job.id}  name=${name}  status=${job.status}`)
console.log(`  curl ${trainerBase}/train/jobs/${job.id}`)
console.log(`  curl ${trainerBase}/train/jobs/${job.id}/log`)

async function fetchJson(path, init) {
  const url = /^https?:\/\//.test(path) ? path : `${trainerBase}${path}`
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`)
  return res.json()
}
