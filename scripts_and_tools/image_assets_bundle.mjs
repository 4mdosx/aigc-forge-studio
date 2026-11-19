// image_assets 已通过条目的打包格式。导出、导入脚本共用。
// 包内是一个 tar.gz：
//   manifest.json
//   files/capture/assets/<hash>/<file>
// 只收 status = approved。路径相对 data/，与库里 original_path 等列一致。

import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUNDLE_FORMAT = 'aigc-image-assets'
export const BUNDLE_VERSION = 1

const PATH_FIELDS = ['original_path', 'processed_path', 'thumb_path', 'nobg_path']
const HASH_RE = /^[a-f0-9]{64}$/
const ID_RE = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/
const FILE_RE = /^capture\/assets\/([a-f0-9]{64})\/([A-Za-z0-9._-]+)$/
const COLUMN_RE = /^[a-z_]+$/

export function repoRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

export function layoutFrom(values) {
  const root = repoRoot()
  return {
    dbPath: resolve(values.db ?? join(root, 'data', 'runner.sqlite')),
    dataDir: resolve(values.data ?? join(root, 'data')),
  }
}

function openDb(path, readOnly) {
  if (!existsSync(path)) throw new Error(`数据库不存在: ${path}`)
  const db = new DatabaseSync(path, { readOnly })
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

function tableInfo(db) {
  const rows = db.prepare('PRAGMA table_info(image_assets)').all()
  if (rows.length === 0) throw new Error('数据库里没有 image_assets 表')
  return rows
}

function plainRow(columns, row) {
  const out = {}
  for (const name of columns) out[name] = row[name] ?? null
  return out
}

function normalizeRel(value) {
  if (value == null) return ''
  return String(value).trim().replaceAll('\\', '/').replace(/^\.\/+/, '')
}

function parseAssetFile(rel) {
  const match = FILE_RE.exec(rel)
  if (!match) return null
  if (match[2] === '.' || match[2] === '..') return null
  return { hash: match[1], name: match[2] }
}

function isInside(parent, target) {
  const back = relative(parent, target)
  return back === '' || (!back.startsWith('..') && !isAbsolute(back))
}

function absInside(root, rel) {
  if (!rel || isAbsolute(rel)) throw new Error(`非法路径: ${rel}`)
  const abs = resolve(root, rel)
  const back = relative(root, abs)
  if (back === '' || back.startsWith('..') || isAbsolute(back)) throw new Error(`路径越界: ${rel}`)
  return abs
}

function filesForAsset(dataDir, row, warnings) {
  const hash = String(row.hash ?? '')
  const found = new Set()
  const add = (rel) => {
    if (!rel) return
    const parsed = parseAssetFile(rel)
    if (!parsed || parsed.hash !== hash) {
      warnings.push(`${row.id}: 忽略非本资产路径 ${rel}`)
      return
    }
    const abs = absInside(dataDir, rel)
    if (!existsSync(abs)) {
      warnings.push(`${row.id}: 文件不存在 ${rel}`)
      return
    }
    const st = lstatSync(abs)
    if (!st.isFile()) {
      warnings.push(`${row.id}: 不是普通文件 ${rel}`)
      return
    }
    found.add(rel)
  }

  for (const field of PATH_FIELDS) add(normalizeRel(row[field]))

  const dir = join(dataDir, 'capture', 'assets', hash)
  if (existsSync(dir) && lstatSync(dir).isDirectory()) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue
      add(`capture/assets/${hash}/${name}`)
    }
  }
  return [...found].sort()
}

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

function runTar(args) {
  const result = spawnSync('tar', args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  if (result.error) throw new Error(`无法运行 tar: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`tar 失败，退出码 ${result.status}`)
}

function sqlValue(value, id, column) {
  if (value == null) return null
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') return value
  throw new Error(`${id}.${column} 不是字符串、数字或空值`)
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest 无效')
  if (manifest.format !== BUNDLE_FORMAT || manifest.version !== BUNDLE_VERSION) {
    throw new Error('不是 image_assets 打包文件，或版本不支持')
  }
  if (!Array.isArray(manifest.columns) || manifest.columns.length === 0) {
    throw new Error('manifest.columns 无效')
  }
  for (const name of manifest.columns) {
    if (typeof name !== 'string' || !COLUMN_RE.test(name)) throw new Error(`非法列名: ${name}`)
  }
  if (!manifest.columns.includes('id') || !manifest.columns.includes('hash')) {
    throw new Error('manifest 缺少 id 或 hash 列')
  }
  if (!Array.isArray(manifest.assets)) throw new Error('manifest 缺少 assets')

  const ids = new Set()
  const hashes = new Set()
  for (const asset of manifest.assets) {
    const row = asset?.row
    if (!row || typeof row !== 'object') throw new Error('manifest 条目缺少 row')
    if (typeof row.id !== 'string' || !ID_RE.test(row.id)) throw new Error(`非法 id: ${row.id}`)
    if (typeof row.hash !== 'string' || !HASH_RE.test(row.hash)) throw new Error(`非法 hash: ${row.hash}`)
    if (row.status !== 'approved') throw new Error(`${row.id} 不是已通过条目`)
    if (ids.has(row.id)) throw new Error(`包内重复 id: ${row.id}`)
    if (hashes.has(row.hash)) throw new Error(`包内重复 hash: ${row.hash}`)
    ids.add(row.id)
    hashes.add(row.hash)
    if (!Array.isArray(asset.files)) throw new Error(`${row.id} 缺少 files`)
    for (const rel of asset.files) {
      if (typeof rel !== 'string') throw new Error(`${row.id} 含非法文件路径`)
      const parsed = parseAssetFile(rel)
      if (!parsed || parsed.hash !== row.hash) throw new Error(`${row.id} 含非法文件路径: ${rel}`)
    }
  }
  return manifest
}

export function exportImageAssets({ db, data, out, dryRun }) {
  const { dbPath, dataDir } = layoutFrom({ db, data })
  if (!existsSync(dataDir)) throw new Error(`数据目录不存在: ${dataDir}`)
  const database = openDb(dbPath, true)
  try {
    const columns = tableInfo(database).map((column) => column.name)
    const rows = database
      .prepare(`SELECT * FROM image_assets WHERE status = 'approved' ORDER BY created_at, id`)
      .all()
    const warnings = []
    const assets = rows.map((row) => ({
      row: plainRow(columns, row),
      files: filesForAsset(dataDir, row, warnings),
    }))
    let bytes = 0
    let fileCount = 0
    const seen = new Set()
    for (const asset of assets) {
      for (const rel of asset.files) {
        if (seen.has(rel)) continue
        seen.add(rel)
        fileCount += 1
        bytes += statSync(absInside(dataDir, rel)).size
      }
    }
    const summary = {
      assets: assets.length,
      files: fileCount,
      bytes,
      missing: assets.filter((asset) => asset.files.length === 0).map((asset) => asset.row.id),
    }
    for (const warning of warnings) console.warn(`警告 ${warning}`)
    if (dryRun) return { ...summary, out: null, dryRun: true }

    const outPath = resolve(
      out ?? join(repoRoot(), 'data', 'exports', `image-assets-${stamp()}.tar.gz`),
    )
    if (existsSync(outPath)) throw new Error(`输出已存在: ${outPath}`)
    if (isInside(join(dataDir, 'capture'), outPath)) throw new Error('输出不能写在 data/capture 里')

    const stage = mkdtempSync(join(tmpdir(), 'image-assets-export-'))
    try {
      const manifest = {
        format: BUNDLE_FORMAT,
        version: BUNDLE_VERSION,
        exportedAt: new Date().toISOString(),
        status: 'approved',
        columns,
        assets,
      }
      writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest)}\n`)
      mkdirSync(join(stage, 'files'), { recursive: true })
      for (const rel of seen) {
        const dest = join(stage, 'files', rel)
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(absInside(dataDir, rel), dest)
      }
      mkdirSync(dirname(outPath), { recursive: true })
      try {
        runTar(['-czf', outPath, '-C', stage, 'manifest.json', 'files'])
      } catch (err) {
        rmSync(outPath, { force: true })
        throw err
      }
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }
    return { ...summary, out: outPath, dryRun: false }
  } finally {
    database.close()
  }
}

export function importImageAssets({ archive, db, data, dryRun }) {
  if (!archive) throw new Error('缺少打包文件')
  const archivePath = resolve(archive)
  if (!existsSync(archivePath)) throw new Error(`打包文件不存在: ${archivePath}`)
  const { dbPath, dataDir } = layoutFrom({ db, data })
  if (!existsSync(dataDir)) throw new Error(`数据目录不存在: ${dataDir}`)

  const stage = mkdtempSync(join(tmpdir(), 'image-assets-import-'))
  try {
    runTar(['-xzf', archivePath, '-C', stage])
    const manifestPath = join(stage, 'manifest.json')
    if (!existsSync(manifestPath)) throw new Error('包内没有 manifest.json')
    const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
    for (const asset of manifest.assets) {
      for (const rel of asset.files) {
        const src = join(stage, 'files', rel)
        if (!existsSync(src) || !lstatSync(src).isFile()) throw new Error(`包内缺少文件: ${rel}`)
      }
    }

      const database = openDb(dbPath, Boolean(dryRun))
    try {
      const info = tableInfo(database)
      const tableNames = new Set(info.map((column) => column.name))
      const insertCols = manifest.columns.filter((name) => tableNames.has(name))
      if (!insertCols.includes('id') || !insertCols.includes('hash')) {
        throw new Error('当前 image_assets 表对不上包内的 id/hash')
      }
      for (const column of info) {
        if (column.notnull && column.dflt_value == null && !insertCols.includes(column.name)) {
          throw new Error(`当前库有必填列不在包里: ${column.name}`)
        }
      }
      const unknown = manifest.columns.filter((name) => !tableNames.has(name))

      const byId = database.prepare('SELECT id, hash FROM image_assets WHERE id = ?')
      const byHash = database.prepare('SELECT id, hash FROM image_assets WHERE hash = ?')
      const insert = database.prepare(
        `INSERT INTO image_assets (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')})`,
      )

      const planned = []
      const skipped = []
      const conflicts = []
      for (const asset of manifest.assets) {
        const row = asset.row
        const existingId = byId.get(row.id)
        const existingHash = byHash.get(row.hash)
        if (existingId) {
          skipped.push(row.id)
          continue
        }
        if (existingHash) {
          conflicts.push(`${row.id} 的 hash 已属于 ${existingHash.id}`)
          continue
        }
        planned.push(asset)
      }

      const filePlan = []
      const seenFiles = new Set()
      for (const asset of manifest.assets) {
        for (const rel of asset.files) {
          if (seenFiles.has(rel)) continue
          seenFiles.add(rel)
          const dest = absInside(dataDir, rel)
          filePlan.push({ rel, dest, exists: existsSync(dest) })
        }
      }

      if (!dryRun) {
        try {
          database.exec('BEGIN IMMEDIATE')
          for (const asset of planned) {
            insert.run(
              ...insertCols.map((name) => sqlValue(asset.row[name] ?? null, asset.row.id, name)),
            )
          }
          database.exec('COMMIT')
        } catch (err) {
          try {
            database.exec('ROLLBACK')
          } catch {
            // 事务已经结束时忽略
          }
          throw err
        }
        for (const file of filePlan) {
          if (file.exists) continue
          mkdirSync(dirname(file.dest), { recursive: true })
          copyFileSync(join(stage, 'files', file.rel), file.dest)
        }
      }

      return {
        dryRun: Boolean(dryRun),
        inserted: planned.length,
        skipped: skipped.length,
        conflicts,
        filesWritten: filePlan.filter((file) => !file.exists).length,
        filesSkipped: filePlan.filter((file) => file.exists).length,
        unknownColumns: unknown,
      }
    } finally {
      database.close()
    }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
