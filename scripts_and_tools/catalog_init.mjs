#!/usr/bin/env node
// 按 catalog.json 落目录骨架：每个 source 一个目录 + meta.json，不下载任何图。
// 用法：
//   node scripts_and_tools/catalog_init.mjs --batch mecha-core
//   node scripts_and_tools/catalog_init.mjs --batch mecha-core --dry
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = { batch: null, dry: false }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--batch') args.batch = argv[++i]
  else if (a === '--dry') args.dry = true
  else throw new Error(`未知参数 ${a}`)
}
if (!args.batch) throw new Error('必须给 --batch')

const batchDir = join(ROOT, 'data', 'capture', args.batch)
const catalogPath = join(batchDir, 'catalog.json')
if (!existsSync(catalogPath)) throw new Error(`找不到 ${catalogPath}`)
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))

const IMG = /\.(png|jpe?g|webp)$/i
function countImages(dir) {
  if (!existsSync(dir)) return 0
  let n = 0
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) n += countImages(p)
    else if (IMG.test(e)) n++
  }
  return n
}

let created = 0
let touched = 0
for (const s of catalog.sources) {
  const dir = join(batchDir, s.dir)
  const metaPath = join(dir, 'meta.json')
  const downloaded = countImages(dir)
  const inPool = s.existingInPool ?? 0
  // 状态：seed 恒 ready；落盘够了 ready；有货但不够 partial；两处都没有 todo
  const status =
    s.kind === 'seed' ? 'ready' : downloaded >= s.target ? 'ready' : downloaded > 0 || inPool > 0 ? 'partial' : 'todo'
  if (args.dry) {
    console.log(
      `${s.id.padEnd(28)} target ${String(s.target).padStart(3)}  池内 ${String(inPool).padStart(3)}  已落 ${String(downloaded).padStart(3)}  ${status.padEnd(8)} ${s.kind}`,
    )
    continue
  }
  mkdirSync(dir, { recursive: true })
  const meta = {
    id: s.id,
    kind: s.kind,
    tag: s.tag ?? null,
    styleFit: s.styleFit ?? null,
    target: s.target,
    existingInPool: inPool,
    note: s.note ?? '',
    status,
    managedBy: 'catalog.json',
    updatedAt: new Date().toISOString(),
  }
  const prev = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n')
  if (!prev) created++
  else touched++
  s.downloaded = downloaded
  s.status = status
}

if (!args.dry) {
  for (const d of ['meta', 'sheets']) mkdirSync(join(batchDir, d), { recursive: true })
  const totalTarget = catalog.sources.reduce((a, s) => a + s.target, 0)
  const totalPool = catalog.sources.reduce((a, s) => a + (s.existingInPool ?? 0), 0)
  const totalHave = catalog.sources.reduce((a, s) => a + countImages(join(batchDir, s.dir)), 0)
  catalog.counts = {
    ...catalog.counts,
    sources: catalog.sources.length,
    targetTotal: totalTarget,
    existingInPoolTotal: totalPool,
    downloadedTotal: totalHave,
    haveTotal: totalPool + totalHave,
    artists: catalog.sources.filter((s) => s.kind === 'artist').length,
    ips: catalog.sources.filter((s) => s.kind === 'copyright').length,
  }
  catalog.updatedAt = new Date().toISOString()
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n')
  console.log(`目录骨架 ${args.batch}：新建 ${created} 个 source 目录，更新 ${touched} 个`)
  console.log(
    `目标 ${totalTarget} 张｜池内可筛 ${totalPool}｜已落目录 ${totalHave}｜来源 ${catalog.counts.sources}（画师 ${catalog.counts.artists} / IP ${catalog.counts.ips}）`,
  )
}
