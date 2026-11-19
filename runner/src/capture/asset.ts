import { execFile as execFileCb } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import type { DatabaseSync } from 'node:sqlite'

import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'

const execFile = promisify(execFileCb)

export type ImageStatus = 'collected' | 'processed' | 'approved' | 'rejected'

export type ImageAsset = {
  id: string
  status: ImageStatus
  source: {
    type: 'manual' | 'crawler'
    sourceUrl: string
    imgUrl: string
    parentImageId?: string
  }
  original: {
    path: string
    width: number
    height: number
    hash: string
  }
  processed?: {
    path: string
    width: number
    height: number
  }
  tags: string[]
  embedding: number[]
  tagsModelVersion: string
  embeddingModelVersion: string
  reviewedAt: number
  note?: string
  createdAt: number
  updatedAt: number
  originalUrl: string
  processedUrl: string | null
}

type AssetRow = {
  id: string
  status: string
  source_type: string
  source_url: string
  img_url: string
  parent_image_id: string | null
  original_path: string
  original_width: number
  original_height: number
  hash: string
  processed_path: string | null
  processed_width: number | null
  processed_height: number | null
  tags_json: string
  embedding_json: string
  tags_model_version: string
  embedding_model_version: string
  reviewed_at: number
  note: string | null
  created_at: number
  updated_at: number
}

const EMBEDDING_MODEL = 'style-embedder-v4'

export function resumeCollected(runner: Runner): void {
  const rows = runner.db
    .prepare(`SELECT id FROM image_assets WHERE status = 'collected'`)
    .all() as { id: string }[]
  for (const row of rows) void processAsset(runner, row.id)
}

export function listAssets(db: DatabaseSync): ImageAsset[] {
  const rows = db
    .prepare('SELECT * FROM image_assets ORDER BY created_at DESC')
    .all() as AssetRow[]
  return rows.map(assetOf)
}

export function assetById(db: DatabaseSync, id: string): ImageAsset | null {
  const row = db.prepare('SELECT * FROM image_assets WHERE id = ?').get(id) as AssetRow | undefined
  return row ? assetOf(row) : null
}

export function assetByHash(db: DatabaseSync, hash: string): ImageAsset | null {
  const row = db.prepare('SELECT * FROM image_assets WHERE hash = ?').get(hash) as AssetRow | undefined
  return row ? assetOf(row) : null
}

export async function ingestBytes(
  runner: Runner,
  bytes: Buffer,
  ext: string,
  source: ImageAsset['source'],
): Promise<{ asset: ImageAsset; duplicate: boolean }> {
  if (bytes.length < 1000) throw new RunnerError('文件太小，不是有效图片')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const existing = assetByHash(runner.db, hash)
  if (existing) return { asset: existing, duplicate: true }

  const tempDir = join(runner.dataDir, 'capture', 'temp')
  mkdirSync(tempDir, { recursive: true })
  const tempAbs = join(tempDir, `${randomBytes(8).toString('hex')}${ext}`)
  writeFileSync(tempAbs, bytes)

  const dirRel = join('capture', 'raw', hash)
  const dirAbs = join(runner.dataDir, dirRel)
  mkdirSync(dirAbs, { recursive: true })
  const originalRel = join(dirRel, `original${ext}`)
  const originalAbs = join(runner.dataDir, originalRel)
  renameSync(tempAbs, originalAbs)
  const { width, height } = await pixelSize(originalAbs)
  const now = runner.now().getTime()
  const id = assetId(runner.now())
  runner.db
    .prepare(
      `INSERT INTO image_assets (
        id, status, source_type, source_url, img_url, parent_image_id,
        original_path, original_width, original_height, hash,
        tags_json, embedding_json, tags_model_version, embedding_model_version,
        reviewed_at, created_at, updated_at
      ) VALUES (?, 'collected', ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '', '', 0, ?, ?)`,
    )
    .run(
      id,
      source.type,
      source.sourceUrl,
      source.imgUrl,
      source.parentImageId ?? null,
      originalRel,
      width,
      height,
      hash,
      now,
      now,
    )
  const asset = assetById(runner.db, id)
  if (!asset) throw new RunnerError('采集入库失败', 500)
  return { asset, duplicate: false }
}

export async function processAsset(runner: Runner, id: string): Promise<void> {
  const asset = assetById(runner.db, id)
  if (!asset || asset.status === 'approved' || asset.status === 'rejected') return
  const hash = asset.original.hash
  const rootKind = asset.original.path.startsWith('capture/assets/') ? 'assets' : 'raw'
  const processedRel = join('capture', rootKind, hash, 'processed.png')
  const processedAbs = join(runner.dataDir, processedRel)
  const originalAbs = join(runner.dataDir, asset.original.path)
  const base = criticBaseURL(runner.dataDir)
  try {
    const prepared = await prepareImage(runner.dataDir, base, originalAbs, processedAbs)
    const preparedAt = runner.now().getTime()
    runner.db
      .prepare(
        `UPDATE image_assets SET
          processed_path = ?, processed_width = ?, processed_height = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(processedRel, prepared.width, prepared.height, preparedAt, id)
    const tagged = await criticJson<{ tags?: string[]; model?: string }>(base, '/tag', {
      path: processedAbs,
    })
    const embedded = await criticJson<{ styleVec?: number[] }>(base, '/embed', {
      path: processedAbs,
    })
    const tags = Array.isArray(tagged.tags) ? tagged.tags.filter((tag) => typeof tag === 'string') : []
    const embedding = Array.isArray(embedded.styleVec)
      ? embedded.styleVec.filter((value) => typeof value === 'number')
      : []
    const now = runner.now().getTime()
    runner.db
      .prepare(
        `UPDATE image_assets SET
          status = CASE WHEN status IN ('approved', 'rejected') THEN status ELSE 'processed' END,
          processed_path = ?, processed_width = ?, processed_height = ?,
          tags_json = ?, embedding_json = ?,
          tags_model_version = ?, embedding_model_version = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        processedRel,
        prepared.width,
        prepared.height,
        JSON.stringify(tags),
        JSON.stringify(embedding),
        tagged.model ?? '',
        EMBEDDING_MODEL,
        now,
        id,
      )
  } catch (err) {
    console.error(`[capture] process ${id}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function updateAsset(
  runner: Runner,
  id: string,
  patch: {
    sourceUrl?: string
    imgUrl?: string
    tags?: string[]
    embedding?: number[]
    note?: string | null
  },
): ImageAsset {
  const current = assetById(runner.db, id)
  if (!current) throw new RunnerError('image not found', 404)
  const now = runner.now().getTime()
  runner.db
    .prepare(
      `UPDATE image_assets SET
        source_url = ?, img_url = ?, tags_json = ?, embedding_json = ?, note = ?, updated_at = ?
      WHERE id = ?`,
    )
    .run(
      patch.sourceUrl ?? current.source.sourceUrl,
      patch.imgUrl ?? current.source.imgUrl,
      JSON.stringify(patch.tags ?? current.tags),
      JSON.stringify(patch.embedding ?? current.embedding),
      patch.note === undefined ? (current.note ?? null) : patch.note,
      now,
      id,
    )
  const next = assetById(runner.db, id)
  if (!next) throw new RunnerError('image not found', 404)
  return next
}

export function approveAsset(runner: Runner, id: string): ImageAsset {
  return moveReviewed(runner, id, 'approved')
}

export function rejectAsset(runner: Runner, id: string): ImageAsset {
  const current = assetById(runner.db, id)
  if (!current) throw new RunnerError('image not found', 404)
  const now = runner.now().getTime()
  runner.db
    .prepare(`UPDATE image_assets SET status = 'rejected', reviewed_at = ?, updated_at = ? WHERE id = ?`)
    .run(now, now, id)
  const next = assetById(runner.db, id)
  if (!next) throw new RunnerError('image not found', 404)
  return next
}

function moveReviewed(runner: Runner, id: string, status: 'approved'): ImageAsset {
  const current = assetById(runner.db, id)
  if (!current) throw new RunnerError('image not found', 404)
  const hash = current.original.hash
  const from = join(runner.dataDir, 'capture', 'raw', hash)
  const to = join(runner.dataDir, 'capture', 'assets', hash)
  if (existsSync(from)) {
    mkdirSync(dirname(to), { recursive: true })
    if (existsSync(to)) throw new RunnerError(`assets 已存在: ${hash}`, 409)
    renameSync(from, to)
  }
  const now = runner.now().getTime()
  const originalPath = current.original.path.replace(/^capture\/raw\//, 'capture/assets/')
  const processedPath = current.processed?.path.replace(/^capture\/raw\//, 'capture/assets/') ?? null
  runner.db
    .prepare(
      `UPDATE image_assets SET
        status = ?, original_path = ?, processed_path = ?, reviewed_at = ?, updated_at = ?
      WHERE id = ?`,
    )
    .run(status, originalPath, processedPath, now, now, id)
  const next = assetById(runner.db, id)
  if (!next) throw new RunnerError('image not found', 404)
  return next
}

function assetOf(row: AssetRow): ImageAsset {
  const tags = parseStringList(row.tags_json)
  const embedding = parseNumberList(row.embedding_json)
  const source: ImageAsset['source'] = {
    type: row.source_type === 'crawler' ? 'crawler' : 'manual',
    sourceUrl: row.source_url,
    imgUrl: row.img_url,
  }
  if (row.parent_image_id) source.parentImageId = row.parent_image_id
  const asset: ImageAsset = {
    id: row.id,
    status: row.status as ImageStatus,
    source,
    original: {
      path: row.original_path,
      width: row.original_width,
      height: row.original_height,
      hash: row.hash,
    },
    tags,
    embedding,
    tagsModelVersion: row.tags_model_version,
    embeddingModelVersion: row.embedding_model_version,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    originalUrl: fileUrl(row.original_path),
    processedUrl: row.processed_path ? fileUrl(row.processed_path) : null,
  }
  if (row.processed_path && row.processed_width && row.processed_height) {
    asset.processed = {
      path: row.processed_path,
      width: row.processed_width,
      height: row.processed_height,
    }
  }
  if (row.note) asset.note = row.note
  return asset
}

function fileUrl(storedPath: string): string {
  const rel = storedPath.replace(/^capture\//, '')
  return `/capture/file/${rel}`
}

function parseStringList(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => typeof item === 'string')
  } catch {
    return []
  }
}

function parseNumberList(text: string): number[] {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => typeof item === 'number')
  } catch {
    return []
  }
}

function assetId(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${stamp}-${randomBytes(2).toString('hex')}`
}

async function pixelSize(file: string): Promise<{ width: number; height: number }> {
  try {
    const { stdout } = await execFile('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file])
    return {
      width: Number(/pixelWidth: (\d+)/.exec(stdout)?.[1]) || 0,
      height: Number(/pixelHeight: (\d+)/.exec(stdout)?.[1]) || 0,
    }
  } catch {
    return { width: 0, height: 0 }
  }
}

function criticBaseURL(dataDir: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(dirname(dataDir), 'config.json'), 'utf8')) as {
      critic?: { baseURL?: string }
    }
    const url = raw.critic?.baseURL
    if (typeof url === 'string' && url.trim() !== '') return url.replace(/\/$/, '')
  } catch {
    // 配置缺失时用本机默认端口
  }
  return 'http://127.0.0.1:8791'
}

async function prepareImage(
  dataDir: string,
  base: string,
  originalAbs: string,
  processedAbs: string,
): Promise<{ width: number; height: number }> {
  try {
    return await criticJson<{ width: number; height: number }>(base, '/prepare', {
      path: originalAbs,
      out: processedAbs,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!/404|not found|unexpected token|<!doctype/i.test(message) && !message.includes('prepare')) {
      // 服务在，但预处理本身失败
      if (!/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)) throw err
    }
    return prepareWithPython(dataDir, originalAbs, processedAbs)
  }
}

function prepareWithPython(
  dataDir: string,
  originalAbs: string,
  processedAbs: string,
): Promise<{ width: number; height: number }> {
  const root = dirname(dataDir)
  const python = join(root, '.venv', 'bin', 'python')
  const script = `
import sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(root)})
from critic.preprocess import prepare
image = prepare(Path(${JSON.stringify(originalAbs)}))
out = Path(${JSON.stringify(processedAbs)})
out.parent.mkdir(parents=True, exist_ok=True)
image.save(out, format="PNG")
print(image.size[0], image.size[1])
`
  return execFile(python, ['-c', script]).then(({ stdout }) => {
    const [width, height] = stdout.trim().split(/\s+/).map(Number)
    return { width: width || 0, height: height || 0 }
  })
}

async function criticJson<T>(base: string, path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await res.json()) as { ok?: boolean; error?: string }
  if (!res.ok || payload.ok === false) {
    throw new Error(payload.error || `${path} ${res.status}`)
  }
  return payload as T
}
