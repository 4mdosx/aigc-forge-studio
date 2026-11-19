#!/usr/bin/env node
// 用 export_image_assets.mjs 打出的包，把当前没有的条目和图片补进本机。
// 已有的 id、已被占用的 hash、已存在的文件都不覆盖。
//
//   node scripts_and_tools/import_image_assets.mjs data/exports/image-assets.tar.gz
//   node scripts_and_tools/import_image_assets.mjs data/exports/image-assets.tar.gz --dry-run
//
// 默认写入 <仓库>/data/runner.sqlite 和 <仓库>/data/capture/assets/<hash>/。

import { parseArgs } from 'node:util'

import { importImageAssets } from './image_assets_bundle.mjs'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: 'string' },
    data: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
})

if (positionals.length !== 1) {
  console.error(
    '用法: node scripts_and_tools/import_image_assets.mjs <image-assets.tar.gz> [--db data/runner.sqlite] [--data data] [--dry-run]',
  )
  process.exit(1)
}

try {
  const result = importImageAssets({
    archive: positionals[0],
    db: values.db,
    data: values.data,
    dryRun: values['dry-run'],
  })
  const verb = result.dryRun ? '将新增' : '新增'
  const fileVerb = result.dryRun ? '将写入' : '写入'
  console.log(
    `${verb} ${result.inserted} 条，跳过已有 ${result.skipped} 条；${fileVerb} ${result.filesWritten} 个文件，跳过已有文件 ${result.filesSkipped} 个`,
  )
  for (const conflict of result.conflicts) console.warn(`跳过（hash 已被占用）: ${conflict}`)
  if (result.unknownColumns.length > 0) {
    console.warn(`当前库没有这些列，已忽略: ${result.unknownColumns.join(', ')}`)
  }
  if (result.dryRun) console.log('dry-run，未写数据库和文件')
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
