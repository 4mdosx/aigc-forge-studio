#!/usr/bin/env node
// 把已通过的 image_assets（status = approved）和对应图片打成一个 tar.gz。
// 含数据库整行，以及 data/capture/assets/<hash>/ 下的图片（processed、thumb、original 等）。
//
//   node scripts_and_tools/export_image_assets.mjs
//   node scripts_and_tools/export_image_assets.mjs --out data/exports/image-assets.tar.gz
//   node scripts_and_tools/export_image_assets.mjs --dry-run
//
// 默认读 <仓库>/data/runner.sqlite，图片相对 <仓库>/data。只读，不改库。

import { parseArgs } from 'node:util'

import { exportImageAssets } from './image_assets_bundle.mjs'

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    data: { type: 'string' },
    out: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
})

try {
  const result = exportImageAssets({
    db: values.db,
    data: values.data,
    out: values.out,
    dryRun: values['dry-run'],
  })
  const size = (result.bytes / 1024 / 1024).toFixed(1)
  console.log(`已通过 ${result.assets} 条，图片 ${result.files} 个，${size} MB`)
  if (result.missing.length > 0) {
    console.warn(`这些条目没有图片文件: ${result.missing.join(', ')}`)
  }
  if (result.dryRun) {
    console.log('dry-run，未写打包文件')
  } else {
    console.log(`写出 ${result.out}`)
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
