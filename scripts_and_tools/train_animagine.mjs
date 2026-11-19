#!/usr/bin/env node
// 把导出的数据集推到训练机，并以 Animagine XL 4.0 Zero 为底模启动 LoRA 训练。
//   node scripts_and_tools/train_animagine.mjs --dataset test-boot
//   node scripts_and_tools/train_animagine.mjs --dataset test-boot --trigger ohwx
//
// 数据源：data/training-export/<dataset>/img（由 export_dataset.mjs 产出）。
// 落点：训练机 C:\AIGC\training\<dataset>\img，底模 C:\AIGC\models\checkpoints\animagine-xl-4.0-zero.safetensors。
// 训练超参走 trainer 默认档（SDXL / bf16 / unet-only / dim128 alpha32 / 10 epochs）。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    dataset: { type: 'string' },
    trigger: { type: 'string', default: '' },
    concurrency: { type: 'string', default: '4' },
  },
})
if (!values.dataset) {
  console.error('需要 --dataset <名字>（export_dataset.mjs 导出的目录名）')
  process.exit(1)
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(readFileSync(join(repoRoot, 'config.json'), 'utf8'))
const trainerBase = String(
  config.runner?.trainerBaseURL ?? 'http://192.168.8.136:8788',
).replace(/\/$/, '')
const dirName = values.dataset.replace(/[^\w.-]+/g, '-')
const imageDir = join(repoRoot, 'data', 'training-export', dirName, 'img')
const BASE_MODEL = 'checkpoints/animagine-xl-4.0-zero.safetensors'

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
console.log(`推送 ${pairs.length}/${images.length} 组 image+caption → ${trainerBase}`)
if (pairs.length === 0) {
  console.error('没有带 caption 的图片')
  process.exit(1)
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
    `警告：底模下载状态 ${modelDownload?.status ?? '未提交'}，训练可能启动失败。`
  )
}

const concurrency = Math.max(1, Number(values.concurrency) || 4)
// /upload 的 path 相对 root，不带 root 名（带 training/ 会落到 training\training）
const target = `${dirName}/img`
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
const name = `${dirName}-az-${stamp}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
const body = {
  name,
  datasetRoot: 'training',
  datasetPath: `${dirName}/img`,
  baseModel: BASE_MODEL,
  scheduler: 'constant',
  ...(values.trigger.trim() ? { keepTokens: 1 } : {}),
}
const { job } = await fetchJson('/train/jobs', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
console.log(`\n训练 job：${job.id}  name=${name}  status=${job.status}`)
console.log(`  curl ${trainerBase}/train/jobs/${job.id}`)
console.log(`  curl ${trainerBase}/train/jobs/${job.id}/log`)

async function fetchJson(path, init) {
  const res = await fetch(`${trainerBase}${path}`, init)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`)
  return res.json()
}
