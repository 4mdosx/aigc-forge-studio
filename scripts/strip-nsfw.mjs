// 清除 data/pose 中的 NSFW 误标痕迹：
// 1. openpose 源文件名剥 NSFW_ 前缀
// 2. library meta.json 删 nsfw 字段 + origin 路径同步剥 NSFW_
// 3. manifest.json 各条目删 nsfw 字段
// 用法: node scripts/strip-nsfw.mjs
import { readdirSync, readFileSync, writeFileSync, renameSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const poseRoot = join(repoRoot, 'data', 'pose')

let renamed = 0
let skipped = 0

// --- 1. openpose 源文件改名 ---
// 同目录存在两个批次（NSFW_ 版与无前缀版内容不同且都被 library 引用）时，
// NSFW_ 版剥前缀后加 _b 后缀避免覆盖，renameMap 记录新名供 origin 同步
const renameMap = new Map() // 'lying/512768/NSFW_lying014.json' -> 'lying/512768/lying014_b.json'

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      walk(p)
    } else if (name.startsWith('NSFW_')) {
      const rel = p.slice(join(poseRoot, 'openpose/').length)
      const clean = name.slice('NSFW_'.length)
      let target = clean
      if (readdirSync(dir).includes(clean)) {
        const dot = clean.lastIndexOf('.')
        target = `${clean.slice(0, dot)}_b${clean.slice(dot)}`
        if (readdirSync(dir).includes(target)) {
          console.warn(`skip (both names exist): ${p}`)
          skipped++
          continue
        }
      }
      renameSync(p, join(dir, target))
      renameMap.set(rel, rel.replace(name, target))
      renamed++
    }
  }
}
walk(join(poseRoot, 'openpose'))
console.log(`renamed files: ${renamed}, skipped: ${skipped}, with _b suffix: ${renameMap.size}`)

// --- 2. library meta.json ---
let metas = 0
let origins = 0
for (const dir of readdirSync(join(poseRoot, 'library'))) {
  if (dir.startsWith('.')) continue
  const metaPath = join(poseRoot, 'library', dir, 'meta.json')
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  if ('nsfw' in meta) delete meta.nsfw
  if (typeof meta.origin === 'string' && meta.origin.includes('NSFW_')) {
    const rel = meta.origin.replace(/^pose\/openpose\//, '')
    meta.origin = renameMap.has(rel)
      ? meta.origin.replace(rel, renameMap.get(rel))
      : meta.origin.replace(/\/NSFW_/, '/')
    origins++
  }
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n')
  metas++
}
console.log(`meta.json rewritten: ${metas} (origin fixed: ${origins})`)

// --- 3. manifest.json ---
const manifestPath = join(poseRoot, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
let stripped = 0
let namesFixed = 0
for (const key of ['poses', 'compositions']) {
  for (const entry of manifest[key] ?? []) {
    if ('nsfw' in entry) {
      delete entry.nsfw
      stripped++
    }
    // composition 条目 name 仍带 NSFW_ 前缀的顺带剥掉
    if (typeof entry.name === 'string' && entry.name.startsWith('NSFW_')) {
      entry.name = entry.name.slice('NSFW_'.length)
      namesFixed++
    }
  }
}
// note 里那句推断规则已失效，同步更新
if (typeof manifest.note === 'string') {
  manifest.note = manifest.note.replace(
    /composition nsfw 由 name 的 NSFW_ 前缀推断。?/,
    '',
  ).trimEnd()
}

// --- 4. 批量放开 pose（2026-11-15 token 裁决）---
// 误标连坐的 enabled=false 全部放开；真缺陷（defects 非空）保持禁用
let enabledCount = 0
for (const dir of readdirSync(join(poseRoot, 'library'))) {
  if (dir.startsWith('.')) continue
  const metaPath = join(poseRoot, 'library', dir, 'meta.json')
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  if (!meta.enabled && !(meta.defects ?? []).length) {
    meta.enabled = true
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n')
    enabledCount++
  }
}
for (const entry of manifest.poses ?? []) {
  if (!entry.enabled && !(entry.defects ?? []).length) entry.enabled = true
}
manifest.enabled = {
  poses: (manifest.poses ?? []).filter((p) => p.enabled).length,
  compositions: (manifest.compositions ?? []).filter((p) => p.enabled).length,
}
console.log(`poses enabled: ${enabledCount} (manifest enabled: ${manifest.enabled.poses})`)

// --- 4b. 批量放开 composition（2026-11-15 token 裁决）---
const compRoot = join(repoRoot, 'data', 'composition')
let compEnabledCount = 0
for (const canvas of readdirSync(compRoot)) {
  if (canvas.startsWith('.')) continue
  for (const dir of readdirSync(join(compRoot, canvas))) {
    if (dir.startsWith('.')) continue
    const metaPath = join(compRoot, canvas, dir, 'meta.json')
    if (!existsSync(metaPath)) continue
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    if (!meta.enabled && !(meta.defects ?? []).length) {
      meta.enabled = true
      writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n')
      compEnabledCount++
    }
  }
}
for (const entry of manifest.compositions ?? []) {
  if (!entry.enabled && !(entry.defects ?? []).length) entry.enabled = true
}
manifest.enabled = {
  poses: (manifest.poses ?? []).filter((p) => p.enabled).length,
  compositions: (manifest.compositions ?? []).filter((p) => p.enabled).length,
}
console.log(`compositions enabled: ${compEnabledCount} (manifest enabled: ${manifest.enabled.compositions})`)

// --- 5. composition 目录 NSFW 清除（2026-11-15 token 裁决）---
// composition/<canvas>/<id>_<compositionName>/meta.json：name/origin 剥 NSFW_ 前缀
// origin 指向 openpose 源文件，改名时若撞 _b 后缀需要跟随
let comps = 0
let compOrigins = 0
for (const canvas of readdirSync(compRoot)) {
  if (canvas.startsWith('.')) continue
  for (const dir of readdirSync(join(compRoot, canvas))) {
    if (dir.startsWith('.')) continue
    const metaPath = join(compRoot, canvas, dir, 'meta.json')
    if (!existsSync(metaPath)) continue
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    if (typeof meta.name === 'string' && meta.name.startsWith('NSFW_')) {
      meta.name = meta.name.slice('NSFW_'.length)
    }
    if (typeof meta.origin === 'string' && meta.origin.includes('NSFW_')) {
      const strippedOrigin = meta.origin.replace(/\/NSFW_/, '/')
      // 源文件可能在冲突批次改名时带了 _b 后缀
      if (!existsSync(join(repoRoot, 'data', strippedOrigin))) {
        const dot = strippedOrigin.lastIndexOf('.')
        const bVariant = `${strippedOrigin.slice(0, dot)}_b${strippedOrigin.slice(dot)}`
        if (existsSync(join(repoRoot, 'data', bVariant))) {
          meta.origin = bVariant
        } else {
          meta.origin = strippedOrigin
        }
      } else {
        meta.origin = strippedOrigin
      }
      compOrigins++
    }
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n')
    comps++
  }
}
console.log(`composition metas rewritten: ${comps} (origin fixed: ${compOrigins})`)

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(`manifest entries nsfw stripped: ${stripped} (name NSFW_ fixed: ${namesFixed})`)
