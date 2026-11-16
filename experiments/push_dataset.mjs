#!/usr/bin/env node
// 把 Mac 侧 capture 数据集推到训练机（trainer /upload）：
//   node experiments/push_dataset.mjs --folder common --dataset style-v1
//   TRAINER_URL=http://192.168.8.136:8788 可覆盖；CONCURRENCY 默认 4。
//
// 数据源约定（runner capture 链）：data/capture/<folder>/image/<id>.jpg + <id>.txt（WD14 打标产物）。
// 或 tools/assemble_dataset.py 的组装产物：--src <dir> 直接指定（含 <id>.jpg + <id>.txt）。
// 只推有 .txt caption 的图——sd-scripts 对没 caption 的 DreamBooth 子集直接报错。
// 落点：C:\AIGC\training\<dataset>\img\<id>.<ext>（trainer 建 job 时 image_dir 指这里）。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    folder: { type: 'string', default: 'common' },
    src: { type: 'string' },
    dataset: { type: 'string', default: 'style-v1' },
    trainer: { type: 'string', default: process.env.TRAINER_URL ?? 'http://192.168.8.136:8788' },
    concurrency: { type: 'string', default: '4' },
    dryRun: { type: 'boolean', default: false },
  },
})

const runnerRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
// --src 优先（assemble_dataset.py 组装产物）；否则走 capture 采集池
const imageDir = values.src
  ? resolve(values.src)
  : join(runnerRoot, 'data', 'capture', values.folder, 'image')
const target = `training/${values.dataset}/img`

try {
  statSync(imageDir)
} catch {
  console.error(`image dir not found: ${imageDir}`)
  process.exit(1)
}

const entries = readdirSync(imageDir)
const images = entries.filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
const pairs = []
for (const image of images) {
  const stem = image.replace(/\.[^.]+$/, '')
  const captionPath = join(imageDir, `${stem}.txt`)
  try {
    statSync(captionPath)
  } catch {
    console.warn(`skip (no caption): ${image}`)
    continue
  }
  pairs.push({ image, stem })
}

console.log(`pushing ${pairs.length} image+caption pairs -> ${values.trainer} /upload ${target}`)
if (values.dryRun) {
  for (const pair of pairs) console.log(`  ${target}/${pair.image}`)
  process.exit(0)
}

let done = 0
let failed = 0
const errors = []

async function uploadOne(base, file) {
  const url = `${values.trainer}/upload?root=${target.split('/')[0]}&path=${encodeURIComponent(
    `${values.dataset}/img/${file.image}`,
  )}`
  const response = await fetch(url, {
    method: 'POST',
    body: readFileSync(join(imageDir, file.image)),
  })
  if (!response.ok) throw new Error(`${file.image}: HTTP ${response.status} ${await response.text()}`)
  await uploadOneText(base, file)
  done += 1
  if (done % 5 === 0) console.log(`  ${done}/${pairs.length}`)
}

async function uploadOneText(base, file) {
  const url = `${values.trainer}/upload?root=${target.split('/')[0]}&path=${encodeURIComponent(
    `${values.dataset}/img/${file.stem}.txt`,
  )}`
  const response = await fetch(url, {
    method: 'POST',
    body: readFileSync(join(imageDir, `${file.stem}.txt`)),
  })
  if (!response.ok) throw new Error(`${file.stem}.txt: HTTP ${response.status} ${await response.text()}`)
}

const workers = Array.from(
  { length: Math.min(Number(values.concurrency), pairs.length) },
  async (_, index) => {
    for (let i = index; i < pairs.length; i += Number(values.concurrency)) {
      try {
        await uploadOne(values.trainer, pairs[i])
      } catch (err) {
        failed += 1
        errors.push(err.message)
        console.error(`FAIL ${err.message}`)
      }
    }
  },
)
await Promise.all(workers)

console.log(`\ndone: ${done} ok, ${failed} failed`)
if (failed > 0) process.exit(1)

console.log(`
下一步（Mac 上直接建训练 job）：
  curl -X POST ${values.trainer}/train/jobs -H 'content-type: application/json' -d '{
    "name": "${values.dataset}",
    "datasetRoot": "training",
    "datasetPath": "${values.dataset}/img",
    "baseModel": "checkpoints/<PD底模文件名>.safetensors"
  }'
然后轮询 GET /train/jobs/<id>，日志 GET /train/jobs/<id>/log`)
