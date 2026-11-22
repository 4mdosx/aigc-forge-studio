#!/usr/bin/env node
// 从 runner /datasets 导出训练集：
//   node scripts_and_tools/export_dataset.mjs --dataset test-boot
//   node scripts_and_tools/export_dataset.mjs --dataset test-boot --trigger ohwx --strip-characters
//
// 两个必需参数：--dataset（数据集名，支持模糊匹配）、--trigger（触发词，可空）。
// 可选 --strip-characters：剥掉 WD14 打标里的角色名（按 tagger 的 selected_tags.csv category=4）。
// 其他默认：processed 版本、跳过 questionable/explicit、输出 data/training-export/<name>/img。
// caption = [trigger,] + tags（逗号连接 + 尾逗号），与 data/wd14-tags.json 同格式。

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    dataset: { type: 'string' },
    trigger: { type: 'string', default: '' },
    'strip-characters': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
})
if (!values.dataset) {
  console.error('需要 --dataset <名字>')
  process.exit(1)
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = join(repoRoot, 'data')
const runnerBase = 'http://127.0.0.1:8787'
const VERSION = 'processed'
// 空集合 = 不按 rating 过滤，questionable / explicit 也一并导出（11-22 定，勿改回）
const SKIP_RATINGS = new Set([])
const TAGGER_CSV = join(
  dataDir,
  'models',
  'wd14',
  'wd-eva02-large-tagger-v3',
  'selected_tags.csv',
)

async function json(path) {
  const res = await fetch(`${runnerBase}${path}`)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`)
  return res.json()
}

function pickDataset(datasets, name) {
  if (datasets.some((d) => d.name === name)) return datasets.find((d) => d.name === name)
  const singular = datasets.find((d) => d.name === name.replace(/s$/, ''))
  if (singular) return singular
  const hits = datasets.filter((d) => d.name.toLowerCase().includes(name.toLowerCase()))
  return hits.length === 1 ? hits[0] : null
}

function characterNames() {
  if (!values['strip-characters']) return new Set()
  const names = new Set()
  for (const line of readFileSync(TAGGER_CSV, 'utf8').trim().split('\n').slice(1)) {
    const [id, name, category] = line.split(',')
    if (category === '4') names.add(name)
  }
  return names
}

const { datasets } = await json('/datasets')
const dataset = pickDataset(datasets, values.dataset)
if (!dataset) {
  console.error(`没找到数据集 ${values.dataset}。现有：`)
  for (const d of datasets) console.error(`  ${d.name} (${d.count} 张)`)
  process.exit(1)
}
console.log(`数据集：${dataset.name} (${dataset.count} 张)`)
if (dataset.name !== values.dataset) console.log(`注意：名字模糊匹配到「${dataset.name}」`)

const chars = characterNames()
if (chars.size) console.log(`剥角色名：启用（词表 ${chars.size} 条）`)

const dirName = dataset.name.replace(/[^\w.-]+/g, '-')
const outDir = join(dataDir, 'training-export', dirName, 'img')
const pairs = []
const skipped = []
let strippedCount = 0

for (const id of dataset.assetIds) {
  let asset
  try {
    asset = await json(`/capture/assets/${id}`)
  } catch (err) {
    skipped.push(`${id}: 取详情失败 ${err.message}`)
    continue
  }
  if (SKIP_RATINGS.has(asset.rating)) {
    skipped.push(`${id}: rating=${asset.rating}`)
    continue
  }
  const image = asset[VERSION]
  if (!image?.path) {
    skipped.push(`${id}: 无 ${VERSION} 版本 (status=${asset.status})`)
    continue
  }
  const source = join(dataDir, image.path)
  if (!existsSync(source)) {
    skipped.push(`${id}: 图片不存在`)
    continue
  }
  let tags = Array.isArray(asset.tags) ? asset.tags : []
  if (tags.length === 0) {
    skipped.push(`${id}: 无 tags`)
    continue
  }
  if (chars.size) {
    const kept = []
    for (const tag of tags) {
      if (chars.has(tag)) strippedCount += 1
      else kept.push(tag)
    }
    tags = kept
  }
  const trigger = values.trigger.trim()
  const caption = `${trigger ? `${trigger}, ` : ''}${tags.join(',')},`
  pairs.push({ id, source, caption, rating: asset.rating })
}

console.log(`可导出 ${pairs.length}/${dataset.assetIds.length} 张 → ${outDir}`)
if (strippedCount) console.log(`已剥角色名 tag ${strippedCount} 次`)
if (skipped.length) {
  console.log('跳过：')
  for (const s of skipped) console.log(`  ${s}`)
}
if (values['dry-run']) {
  console.log('\n预览：')
  for (const p of pairs) console.log(`  ${p.id}.png  ${p.caption.slice(0, 90)}`)
  process.exit(0)
}
if (pairs.length === 0) {
  console.error('没有可导出的图片')
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
for (const p of pairs) {
  copyFileSync(p.source, join(outDir, `${p.id}.png`))
  writeFileSync(join(outDir, `${p.id}.txt`), `${p.caption}\n`)
}
console.log(`已写入 ${pairs.length} 组 image+caption`)
console.log(`下一步：node scripts_and_tools/train_animagine.mjs --dataset ${dirName}`)
