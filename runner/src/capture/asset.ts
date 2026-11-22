import { execFile as execFileCb, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import type { DatabaseSync } from 'node:sqlite'

import { PNG } from 'pngjs'

import { findRepoRoot } from '../config.ts'
import { transaction } from '../db.ts'
import { RunnerError } from '../errors.ts'
import { writeWd14TagTable } from '../tag/table.ts'
import type { Runner } from '../task/queue.ts'
import { enqueueCaptureJob, enqueueEmbedJob, type CaptureStep } from './jobs.ts'
import {
  loadVectors,
  saveVector,
  storedVector,
  vectorVersions,
} from './vectors.ts'

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
  nobg?: {
    path: string
    width: number
    height: number
  }
  tags: string[]
  embedding: number[]
  rating: string
  tagsModelVersion: string
  embeddingModelVersion: string
  reviewedAt: number
  note?: string
  createdAt: number
  updatedAt: number
  originalUrl: string
  processedUrl: string | null
  nobgUrl: string | null
  thumbUrl: string | null
}

export type FinalVersion = 'raw' | 'processed' | 'nobg'

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
  thumb_path: string | null
  nobg_path: string | null
  nobg_width: number | null
  nobg_height: number | null
  tags_json: string
  embedding_json: string
  tags_model_version: string
  rating: string
  embedding_model_version: string
  reviewed_at: number
  note: string | null
  created_at: number
  updated_at: number
}

export const EMBEDDING_MODEL = 'dinov3-cls-224-v1'
const RATINGS = new Set(['general', 'sensitive', 'questionable', 'explicit'])

function ratingOf(value: unknown): string {
  return typeof value === 'string' && RATINGS.has(value) ? value : ''
}
const STEP_TIMEOUT_MS = 180_000
const HASH_RE = /^[a-f0-9]{64}$/
const THUMB_EDGE = 320
const THUMB_NAME = 'thumb.png'

export function listAssets(db: DatabaseSync): ImageAsset[] {
  const rows = db
    .prepare('SELECT * FROM image_assets ORDER BY created_at DESC')
    .all() as AssetRow[]
  return rows.map((row) => assetOf(row))
}

export type AssetListQuery = {
  statuses: string[]
  ratings: string[]
  tags: string[]
  safe: boolean
  datasetId: string | null
}

export type AssetPage = {
  total: number
  offset: number
  size: number
  done: number
  processing: number
  unsafe: number
  items: ImageAsset[]
}

const ASSET_LIST_COLUMNS = `id, status, source_type, source_url, img_url, parent_image_id,
  original_path, original_width, original_height, hash,
  processed_path, processed_width, processed_height,
  thumb_path, nobg_path, nobg_width, nobg_height,
  tags_json, tags_model_version, embedding_model_version, rating,
  reviewed_at, note, created_at, updated_at`

const tagKeyReady = new WeakSet<DatabaseSync>()

export function assetTagKey(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '_')
}

function ensureTagKey(db: DatabaseSync): void {
  if (tagKeyReady.has(db)) return
  db.function('asset_tag_key', (value) =>
    typeof value === 'string' ? assetTagKey(value) : '',
  )
  tagKeyReady.add(db)
}

function assetWhere(query: AssetListQuery): {
  sql: string
  args: Array<string | number>
} {
  const clauses = ['1 = 1']
  const args: Array<string | number> = []
  if (query.statuses.length > 0) {
    clauses.push(
      `image_assets.status IN (${query.statuses.map(() => '?').join(', ')})`,
    )
    args.push(...query.statuses)
  }
  if (query.ratings.length > 0) {
    clauses.push(
      `image_assets.rating IN (${query.ratings.map(() => '?').join(', ')})`,
    )
    args.push(...query.ratings)
  }
  if (query.safe)
    clauses.push(`image_assets.rating NOT IN ('questionable', 'explicit')`)
  if (query.datasetId) {
    clauses.push(
      'image_assets.id IN (SELECT asset_id FROM dataset_assets WHERE dataset_id = ?)',
    )
    args.push(query.datasetId)
  }
  for (const tag of query.tags) {
    const key = assetTagKey(tag)
    if (key === '') continue
    clauses.push(
      'EXISTS (SELECT 1 FROM json_each(image_assets.tags_json) j WHERE asset_tag_key(j.value) = ?)',
    )
    args.push(key)
  }
  return { sql: clauses.join(' AND '), args }
}

function briefAssets(
  rows: Array<Omit<AssetRow, 'embedding_json'>>,
): ImageAsset[] {
  return rows.map((row) => assetOf({ ...row, embedding_json: '[]' }))
}

export function pageAssets(
  db: DatabaseSync,
  query: AssetListQuery & { offset: number; size: number },
): AssetPage {
  if (query.tags.length > 0) ensureTagKey(db)
  const where = assetWhere(query)
  const safe = query.safe ? 1 : 0
  const counts = db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE
          WHEN status IN ('processed', 'approved')
            AND (? = 0 OR rating NOT IN ('questionable', 'explicit'))
          THEN 1 ELSE 0 END), 0) AS done,
        COALESCE(SUM(CASE
          WHEN status = 'collected'
            AND (? = 0 OR rating NOT IN ('questionable', 'explicit'))
          THEN 1 ELSE 0 END), 0) AS processing,
        COALESCE(SUM(CASE WHEN rating IN ('questionable', 'explicit') THEN 1 ELSE 0 END), 0) AS unsafe
      FROM image_assets`,
    )
    .get(safe, safe) as {
    done: number
    processing: number
    unsafe: number
  }
  const filtered = db
    .prepare(`SELECT COUNT(*) AS total FROM image_assets WHERE ${where.sql}`)
    .get(...where.args) as { total: number }
  const rows = db
    .prepare(
      `SELECT ${ASSET_LIST_COLUMNS}
       FROM image_assets WHERE ${where.sql}
       ORDER BY created_at DESC, rowid DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...where.args, query.size, query.offset) as Array<
    Omit<AssetRow, 'embedding_json'>
  >
  return {
    total: filtered.total,
    offset: query.offset,
    size: query.size,
    done: counts.done,
    processing: counts.processing,
    unsafe: counts.unsafe,
    items: briefAssets(rows),
  }
}

export function listAssetIds(
  db: DatabaseSync,
  query: AssetListQuery,
): { total: number; ids: string[] } {
  if (query.tags.length > 0) ensureTagKey(db)
  const where = assetWhere(query)
  const rows = db
    .prepare(
      `SELECT id FROM image_assets WHERE ${where.sql} ORDER BY created_at DESC, rowid DESC`,
    )
    .all(...where.args) as Array<{ id: string }>
  return { total: rows.length, ids: rows.map((row) => row.id) }
}

export function assetsByIds(
  db: DatabaseSync,
  ids: readonly string[],
): ImageAsset[] {
  if (ids.length === 0) return []
  const rows = db
    .prepare(
      `SELECT ${ASSET_LIST_COLUMNS} FROM image_assets WHERE id IN (${ids.map(() => '?').join(', ')})`,
    )
    .all(...ids) as Array<Omit<AssetRow, 'embedding_json'>>
  const byId = new Map(briefAssets(rows).map((asset) => [asset.id, asset]))
  return ids.flatMap((id) => {
    const asset = byId.get(id)
    return asset ? [asset] : []
  })
}

export function assetTagCounts(
  db: DatabaseSync,
  query: AssetListQuery,
): Array<{ tag: string; count: number }> {
  ensureTagKey(db)
  const where = assetWhere({ ...query, tags: [] })
  const rows = db
    .prepare(
      `SELECT asset_tag_key(j.value) AS tag, COUNT(*) AS count
       FROM image_assets, json_each(image_assets.tags_json) AS j
       WHERE ${where.sql} AND asset_tag_key(j.value) <> ''
       GROUP BY asset_tag_key(j.value)
       ORDER BY count DESC, tag ASC`,
    )
    .all(...where.args) as Array<{ tag: string; count: number }>
  return rows
}

export function assetById(db: DatabaseSync, id: string): ImageAsset | null {
  const row = db.prepare('SELECT * FROM image_assets WHERE id = ?').get(id) as
    AssetRow | undefined
  if (!row) return null
  const asset = assetOf(row)
  const stored = storedVector(db, id)
  if (stored) {
    asset.embedding = Array.from(stored.vec)
    asset.embeddingModelVersion = stored.modelVersion
  }
  return asset
}

export type NearestNeighbor = {
  id: string
  cosine: number
  l2: number
  status: ImageStatus
  thumbUrl: string | null
  processedUrl: string | null
  originalUrl: string
  updatedAt: number
}

export type NearestOrder = 'near' | 'far'

export async function nearestAssets(
  runner: Runner,
  id: string,
  k = 10,
  order: NearestOrder = 'near',
  only?: readonly string[],
): Promise<{ id: string; neighbors: NearestNeighbor[] }> {
  if (!Number.isInteger(k) || k < 1) throw new RunnerError('k 必须是正整数')
  if (order !== 'near' && order !== 'far')
    throw new RunnerError('order 必须是 near 或 far')
  const allowed = only ? new Set(idListOf(only)) : null
  const assets = listAssets(runner.db)
  const target = assets.find((asset) => asset.id === id)
  if (!target) throw new RunnerError('image not found', 404)
  const pool = allowed
    ? assets.filter((asset) => asset.id === id || allowed.has(asset.id))
    : assets
  const vectors = poolVectors(runner.db, pool, id)
  const base = criticBaseURL(runner.dataDir)
  const stamps = new Map<string, string>()
  for (const asset of pool) stamps.set(asset.id, String(asset.updatedAt))
  let result: {
    neighbors?: Array<{ id?: unknown; cosine?: unknown; l2?: unknown }>
  }
  try {
    await syncVectors(base, vectors, stamps)
    result = await criticJson(base, '/image-vector/nearest', {
      id,
      k,
      order,
      ids: Object.keys(vectors),
    })
  } catch (err) {
    if (err instanceof RunnerError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new RunnerError(message, 502)
  }
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  const neighbors: NearestNeighbor[] = []
  for (const item of result.neighbors ?? []) {
    if (!item || typeof item.id !== 'string') continue
    const asset = byId.get(item.id)
    if (
      !asset ||
      typeof item.cosine !== 'number' ||
      typeof item.l2 !== 'number'
    )
      continue
    neighbors.push({
      id: asset.id,
      cosine: item.cosine,
      l2: item.l2,
      status: asset.status,
      thumbUrl: asset.thumbUrl,
      processedUrl: asset.processedUrl,
      originalUrl: asset.originalUrl,
      updatedAt: asset.updatedAt,
    })
  }
  neighbors.sort((left, right) => compareNeighbors(left, right, order))
  return { id, neighbors: neighbors.slice(0, k) }
}

export type Balance = 'cluster' | 'even'

export type AssetGroup = {
  ids: string[]
  centerId: string | null
}

export type AssetGroups = {
  groups: AssetGroup[]
  /** 没有可用向量或向量维度对不上，没参与分组。 */
  skipped: string[]
  /** skipped 里因为模型换过、向量过期的那些，需要重建。 */
  stale: string[]
  balance: Balance
}

export async function groupAssets(
  runner: Runner,
  ids: readonly string[],
  groups: number,
  balance: Balance = 'cluster',
): Promise<AssetGroups> {
  const selected = idListOf(ids)
  if (!Number.isInteger(groups) || groups < 1)
    throw new RunnerError('groups 必须是正整数')
  if (balance !== 'cluster' && balance !== 'even')
    throw new RunnerError('balance 必须是 cluster 或 even')
  const assets = listAssets(runner.db)
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  const missing = selected.filter((id) => !byId.has(id))
  if (missing.length > 0) {
    throw new RunnerError(
      `image not found: ${missing.slice(0, 8).join(', ')}`,
      404,
    )
  }
  const vectors: Record<string, number[]> = {}
  const skipped: string[] = []
  const stale: string[] = []
  const stored = loadVectors(runner.db, EMBEDDING_MODEL, selected)
  const versions = vectorVersions(runner.db)
  let dim: number | null = null
  for (const id of selected) {
    const vector = stored.get(id)
    if (!vector || vector.length === 0) {
      skipped.push(id)
      if (versions.get(id) !== EMBEDDING_MODEL) stale.push(id)
      continue
    }
    if (dim !== null && vector.length !== dim) {
      skipped.push(id)
      stale.push(id)
      continue
    }
    dim ??= vector.length
    vectors[id] = Array.from(vector)
  }
  const usable = Object.keys(vectors)
  if (usable.length === 0) throw new RunnerError('这些图片还没有向量')
  if (groups > usable.length) {
    throw new RunnerError(
      `可分组的图片有 ${usable.length} 张，groups 必须在 1 到 ${usable.length} 之间`,
    )
  }
  const packed = await splitVectors(
    runner.dataDir,
    vectors,
    usable,
    groups,
    balance,
  )
  return { groups: packed, skipped, stale, balance }
}

async function splitVectors(
  dataDir: string,
  vectors: Record<string, number[]>,
  ids: string[],
  groups: number,
  balance: Balance,
): Promise<AssetGroup[]> {
  const root = findRepoRoot([dirname(dataDir), import.meta.dirname])
  const python = join(root, '.venv', 'bin', 'python')
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(root)})
from critic.image_vector import split
payload = json.load(sys.stdin)
json.dump(
    split(payload["ids"], int(payload["groups"]), vectors=payload["vectors"], balance=payload["balance"]),
    sys.stdout,
)
`
  let stdout = ''
  try {
    stdout = await runPython(
      python,
      script,
      JSON.stringify({ vectors, ids, groups, balance }),
    )
  } catch (err) {
    if (err instanceof RunnerError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new RunnerError(message, 502)
  }
  let parsed: { groups?: Array<{ ids?: unknown; centerId?: unknown }> }
  try {
    parsed = JSON.parse(stdout) as {
      groups?: Array<{ ids?: unknown; centerId?: unknown }>
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new RunnerError(message, 502)
  }
  const packed: AssetGroup[] = []
  const seen = new Set<string>()
  for (const group of parsed.groups ?? []) {
    if (!group || !Array.isArray(group.ids)) continue
    const groupIds = group.ids.filter(
      (id): id is string =>
        typeof id === 'string' && id in vectors && !seen.has(id),
    )
    for (const id of groupIds) seen.add(id)
    if (groupIds.length === 0) continue
    const centerId =
      typeof group.centerId === 'string' && groupIds.includes(group.centerId)
        ? group.centerId
        : null
    packed.push({ ids: groupIds, centerId })
  }
  if (packed.length !== groups || seen.size !== ids.length) {
    throw new RunnerError(
      `分组结果是 ${packed.length} 组，期望 ${groups} 组`,
      502,
    )
  }
  return packed
}

function runPython(
  python: string,
  script: string,
  input: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('分组超时'))
    }, STEP_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(
          new Error(
            Buffer.concat(stderr).toString().trim() || `python 退出 ${code}`,
          ),
        )
        return
      }
      resolve(Buffer.concat(stdout).toString())
    })
    child.stdin?.end(input)
  })
}

export function idListOf(ids: readonly string[]): string[] {
  if (ids.length === 0) throw new RunnerError('ids 不能为空')
  if (ids.length > 2000) throw new RunnerError('ids 过多')
  const seen = new Set<string>()
  const selected: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || id === '')
      throw new RunnerError('ids 里的图片 id 必须是非空字符串')
    if (seen.has(id)) throw new RunnerError(`ids 有重复: ${id}`)
    seen.add(id)
    selected.push(id)
  }
  return selected
}

function compareNeighbors(
  left: NearestNeighbor,
  right: NearestNeighbor,
  order: NearestOrder,
): number {
  if (left.cosine !== right.cosine) {
    return order === 'far'
      ? left.cosine - right.cosine
      : right.cosine - left.cosine
  }
  if (left.l2 !== right.l2) {
    return order === 'far' ? right.l2 - left.l2 : left.l2 - right.l2
  }
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
}

export function assetByHash(db: DatabaseSync, hash: string): ImageAsset | null {
  const row = db
    .prepare('SELECT * FROM image_assets WHERE hash = ?')
    .get(hash) as AssetRow | undefined
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
  if (existing) {
    if (existing.status === 'collected') {
      enqueueCaptureJob(runner.db, existing.id, runner.now().getTime())
    }
    return { asset: existing, duplicate: true }
  }

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
  transaction(runner.db, () => {
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
    enqueueCaptureJob(runner.db, id, now)
  })
  const asset = assetById(runner.db, id)
  if (!asset) throw new RunnerError('采集入库失败', 500)
  return { asset, duplicate: false }
}

export async function runCaptureStep(
  runner: Runner,
  id: string,
  step: CaptureStep,
  signal?: AbortSignal,
): Promise<'tag' | 'embed' | 'done'> {
  const ac = signal ?? AbortSignal.timeout(STEP_TIMEOUT_MS)
  if (ac.aborted) throw abortError(ac)
  const asset = assetById(runner.db, id)
  if (!asset) throw new Error(`image not found: ${id}`)
  if (
    asset.status === 'approved' ||
    asset.status === 'rejected' ||
    asset.status === 'processed'
  ) {
    // 定稿的图不再重跑 prepare / tag；只有向量过期时允许补 embed。
    if (step !== 'embed' || !isEmbeddingStale(asset)) return 'done'
  }
  if (step === 'prepare') {
    await writePrepared(runner, asset, ac)
    return 'tag'
  }
  if (step === 'tag') {
    const current = asset.processed
      ? asset
      : await writePrepared(runner, asset, ac)
    await writeTags(runner, current, ac)
    return 'embed'
  }
  if (step === 'embed') {
    const current = asset.processed
      ? asset
      : await writePrepared(runner, asset, ac)
    await writeEmbedding(runner, current, ac)
    return 'done'
  }
  throw new Error(`unknown step: ${step}`)
}

async function writePrepared(
  runner: Runner,
  asset: ImageAsset,
  signal: AbortSignal,
): Promise<ImageAsset> {
  const hash = asset.original.hash
  const rootKind = asset.original.path.startsWith('capture/assets/')
    ? 'assets'
    : 'raw'
  const processedRel = join('capture', rootKind, hash, 'processed.png')
  const processedAbs = join(runner.dataDir, processedRel)
  const thumbRel = join('capture', rootKind, hash, THUMB_NAME)
  const originalAbs = join(runner.dataDir, asset.original.path)
  const base = criticBaseURL(runner.dataDir)
  const prepared = await prepareImage(
    runner.dataDir,
    base,
    originalAbs,
    processedAbs,
    signal,
  )
  await writeThumb(processedAbs, join(runner.dataDir, thumbRel))
  const preparedAt = runner.now().getTime()
  runner.db
    .prepare(
      `UPDATE image_assets SET
        processed_path = ?, processed_width = ?, processed_height = ?,
        thumb_path = ?, updated_at = ?
      WHERE id = ?`,
    )
    .run(
      processedRel,
      prepared.width,
      prepared.height,
      thumbRel,
      preparedAt,
      asset.id,
    )
  const next = assetById(runner.db, asset.id)
  if (!next) throw new Error(`image not found: ${asset.id}`)
  return next
}

async function writeTags(
  runner: Runner,
  asset: ImageAsset,
  signal: AbortSignal,
): Promise<void> {
  const processedAbs = processedAbsOf(runner, asset)
  const base = criticBaseURL(runner.dataDir)
  const tagged = await criticJson<{
    tags?: string[]
    model?: string
    rating?: string
  }>(base, '/tag', { path: processedAbs }, signal)
  const tags = Array.isArray(tagged.tags)
    ? tagged.tags.filter((tag) => typeof tag === 'string')
    : []
  runner.db
    .prepare(
      `UPDATE image_assets SET tags_json = ?, tags_model_version = ?, rating = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      JSON.stringify(tags),
      tagged.model ?? '',
      ratingOf(tagged.rating),
      runner.now().getTime(),
      asset.id,
    )
  writeWd14TagTable(runner.db, runner.dataDir)
}

async function writeEmbedding(
  runner: Runner,
  asset: ImageAsset,
  signal: AbortSignal,
): Promise<void> {
  const processedAbs = processedAbsOf(runner, asset)
  const base = criticBaseURL(runner.dataDir)
  const embedded = await criticJson<{ styleVec?: number[]; dim?: number }>(
    base,
    '/embed',
    { path: processedAbs },
    signal,
  )
  const embedding = Array.isArray(embedded.styleVec)
    ? embedded.styleVec.filter((value) => typeof value === 'number')
    : []
  if (embedding.length === 0) throw new Error('critic 没返回风格向量')
  const now = runner.now().getTime()
  transaction(runner.db, () => {
    saveVector(runner.db, asset.id, EMBEDDING_MODEL, embedding, now)
    runner.db
      .prepare(
        `UPDATE image_assets SET
          status = CASE WHEN status IN ('approved', 'rejected') THEN status ELSE 'processed' END,
          embedding_json = '[]', embedding_model_version = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(EMBEDDING_MODEL, now, asset.id)
  })
}

function processedAbsOf(runner: Runner, asset: ImageAsset): string {
  if (!asset.processed) throw new Error(`processed image missing: ${asset.id}`)
  return join(runner.dataDir, asset.processed.path)
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('capture job timed out')
}

export function updateAsset(
  runner: Runner,
  id: string,
  patch: {
    sourceUrl?: string
    imgUrl?: string
    tags?: string[]
    embedding?: number[]
    rating?: string
    note?: string | null
  },
): ImageAsset {
  const current = assetById(runner.db, id)
  if (!current) throw new RunnerError('image not found', 404)
  const now = runner.now().getTime()
  transaction(runner.db, () => {
    runner.db
      .prepare(
        `UPDATE image_assets SET
          source_url = ?, img_url = ?, tags_json = ?, rating = ?, note = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        patch.sourceUrl ?? current.source.sourceUrl,
        patch.imgUrl ?? current.source.imgUrl,
        JSON.stringify(patch.tags ?? current.tags),
        patch.rating ?? current.rating,
        patch.note === undefined ? (current.note ?? null) : patch.note,
        now,
        id,
      )
    // 手改向量只走 vectors 表，并把版本记成当前模型，否则会被判成过期。
    if (patch.embedding !== undefined) {
      saveVector(runner.db, id, EMBEDDING_MODEL, patch.embedding, now)
      runner.db
        .prepare(
          `UPDATE image_assets SET embedding_json = '[]', embedding_model_version = ?
           WHERE id = ?`,
        )
        .run(EMBEDDING_MODEL, id)
    }
  })
  const next = assetById(runner.db, id)
  if (!next) throw new RunnerError('image not found', 404)
  if (patch.tags !== undefined) writeWd14TagTable(runner.db, runner.dataDir)
  return next
}

export function approveAsset(
  runner: Runner,
  id: string,
  version: FinalVersion = 'processed',
): Promise<ImageAsset> {
  return moveReviewed(runner, id, version)
}

export function replaceNobg(
  runner: Runner,
  id: string,
  bytes: Buffer,
): ImageAsset {
  const current = assetById(runner.db, id)
  if (!current) throw new RunnerError('image not found', 404)
  if (current.status === 'approved')
    throw new RunnerError('已通过的图片不能再擦除', 409)
  if (!current.nobg) throw new RunnerError('还没有移除背景的版本', 409)
  if (bytes.length < 32 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
    throw new RunnerError('需要 PNG')
  }
  let png: PNG
  try {
    png = PNG.sync.read(bytes)
  } catch {
    throw new RunnerError('需要 PNG')
  }
  if (!png.width || !png.height) throw new RunnerError('需要 PNG')
  const abs = join(runner.dataDir, current.nobg.path)
  writeFileSync(abs, bytes)
  const now = runner.now().getTime()
  runner.db
    .prepare(
      `UPDATE image_assets SET nobg_width = ?, nobg_height = ?, updated_at = ? WHERE id = ?`,
    )
    .run(png.width, png.height, now, id)
  const next = assetById(runner.db, id)
  if (!next) throw new RunnerError('image not found', 404)
  return next
}

export function deleteAsset(runner: Runner, id: string): void {
  const current = assetById(runner.db, id)
  if (!current) throw new RunnerError('image not found', 404)
  const hash = current.original.hash
  if (HASH_RE.test(hash)) {
    for (const kind of ['raw', 'assets']) {
      rmSync(join(runner.dataDir, 'capture', kind, hash), {
        recursive: true,
        force: true,
      })
    }
  }
  transaction(runner.db, () => {
    runner.db.prepare('DELETE FROM jobs WHERE asset_id = ?').run(id)
    runner.db.prepare('DELETE FROM image_assets WHERE id = ?').run(id)
  })
  writeWd14TagTable(runner.db, runner.dataDir)
}

export function rejectAsset(runner: Runner, id: string): ImageAsset {
  const current = assetById(runner.db, id)
  if (!current) throw new RunnerError('image not found', 404)
  if (current.status !== 'processed')
    throw new RunnerError('只有处理完的图片可以拒绝', 409)
  const now = runner.now().getTime()
  runner.db
    .prepare(
      `UPDATE image_assets SET status = 'rejected', reviewed_at = ?, updated_at = ? WHERE id = ?`,
    )
    .run(now, now, id)
  const next = assetById(runner.db, id)
  if (!next) throw new RunnerError('image not found', 404)
  return next
}

async function moveReviewed(
  runner: Runner,
  id: string,
  version: FinalVersion,
): Promise<ImageAsset> {
  const current = assetById(runner.db, id)
  if (!current) throw new RunnerError('image not found', 404)
  if (current.status !== 'processed')
    throw new RunnerError('只有处理完的图片可以通过', 409)
  if (!current.processed) throw new RunnerError('没有处理后的图片', 409)
  if (version === 'nobg' && !current.nobg)
    throw new RunnerError('还没有移除背景的版本', 409)
  if (version === 'raw' && !current.original.path)
    throw new RunnerError('没有原始图片', 409)
  const hash = current.original.hash
  const from = join(runner.dataDir, 'capture', 'raw', hash)
  const to = join(runner.dataDir, 'capture', 'assets', hash)
  const processedName = current.processed.path.split('/').pop()
  const originalName = current.original.path.split('/').pop() ?? ''
  if (!processedName) throw new RunnerError('没有处理后的图片', 409)
  if (existsSync(from)) {
    mkdirSync(dirname(to), { recursive: true })
    if (existsSync(to)) throw new RunnerError(`assets 已存在: ${hash}`, 409)
    renameSync(from, to)
  }
  const keptDir = existsSync(to) ? to : from
  const kept = await settleFinalFiles(
    keptDir,
    version,
    processedName,
    originalName,
  )
  const root = existsSync(to) ? 'assets' : 'raw'
  await writeThumb(join(keptDir, kept.name), join(keptDir, THUMB_NAME))
  const thumbRel = `capture/${root}/${hash}/${THUMB_NAME}`
  const size =
    kept.width && kept.height
      ? { width: kept.width, height: kept.height }
      : version === 'raw'
        ? { width: current.original.width, height: current.original.height }
        : { width: current.processed.width, height: current.processed.height }
  const now = runner.now().getTime()
  runner.db
    .prepare(
      `UPDATE image_assets SET
        status = 'approved', original_path = '',
        processed_path = ?, processed_width = ?, processed_height = ?,
        thumb_path = ?,
        nobg_path = NULL, nobg_width = NULL, nobg_height = NULL,
        reviewed_at = ?, updated_at = ?
      WHERE id = ?`,
    )
    .run(
      `capture/${root}/${hash}/${kept.name}`,
      size.width,
      size.height,
      thumbRel,
      now,
      now,
      id,
    )
  const next = assetById(runner.db, id)
  if (!next) throw new RunnerError('image not found', 404)
  return next
}

export async function settleFinalFiles(
  dir: string,
  version: FinalVersion,
  processedName: string,
  originalName: string,
): Promise<{ name: string; width?: number; height?: number }> {
  const processedAbs = join(dir, processedName)
  const nobgAbs = join(dir, 'nobg.png')
  if (version === 'nobg') {
    if (!existsSync(nobgAbs)) throw new RunnerError('还没有移除背景的版本', 409)
    if (!existsSync(processedAbs))
      throw new RunnerError('没有处理后的图片', 409)
    const canvas = await imageSize(processedAbs)
    await flattenOnWhite(nobgAbs, processedAbs, canvas.width, canvas.height)
    rmSync(nobgAbs, { force: true })
    dropOriginalFiles(dir)
    return { name: processedName, width: canvas.width, height: canvas.height }
  }
  if (version === 'raw') {
    if (!originalName || !existsSync(join(dir, originalName))) {
      throw new RunnerError('没有原始图片', 409)
    }
    rmSync(processedAbs, { force: true })
    rmSync(nobgAbs, { force: true })
    return { name: originalName }
  }
  if (!existsSync(processedAbs)) throw new RunnerError('没有处理后的图片', 409)
  rmSync(nobgAbs, { force: true })
  dropOriginalFiles(dir)
  return { name: processedName }
}

async function imageSize(
  file: string,
): Promise<{ width: number; height: number }> {
  try {
    const png = PNG.sync.read(readFileSync(file))
    if (!png.width || !png.height) throw new Error('empty')
    return { width: png.width, height: png.height }
  } catch {
    throw new RunnerError('无法读取预处理图尺寸')
  }
}

async function flattenOnWhite(
  source: string,
  dest: string,
  width: number,
  height: number,
): Promise<void> {
  const cut = PNG.sync.read(readFileSync(source))
  const out = new PNG({ width, height, colorType: 2 })
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(cut.height - 1, Math.floor((y * cut.height) / height))
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(cut.width - 1, Math.floor((x * cut.width) / width))
      const from = (sy * cut.width + sx) << 2
      const alpha = (cut.data[from + 3] ?? 255) / 255
      const to = (y * width + x) << 2
      out.data[to] = Math.round(
        (cut.data[from] ?? 0) * alpha + 255 * (1 - alpha),
      )
      out.data[to + 1] = Math.round(
        (cut.data[from + 1] ?? 0) * alpha + 255 * (1 - alpha),
      )
      out.data[to + 2] = Math.round(
        (cut.data[from + 2] ?? 0) * alpha + 255 * (1 - alpha),
      )
      out.data[to + 3] = 255
    }
  }
  const tmp = `${dest}.white`
  writeFileSync(tmp, PNG.sync.write(out))
  renameSync(tmp, dest)
}

function dropOriginalFiles(dir: string): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (name.startsWith('original.')) rmSync(join(dir, name))
  }
}

function assetOf(row: AssetRow): ImageAsset {
  const tags = parseStringList(row.tags_json)
  // 向量在 image_vectors 里，只有单张详情才补上；列表页一律空数组。
  const embedding: number[] = []
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
    rating: row.rating ?? '',
    tagsModelVersion: row.tags_model_version,
    embeddingModelVersion: row.embedding_model_version,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    originalUrl: row.original_path ? fileUrl(row.original_path) : '',
    processedUrl: row.processed_path ? fileUrl(row.processed_path) : null,
    nobgUrl: row.nobg_path ? fileUrl(row.nobg_path) : null,
    thumbUrl: row.thumb_path ? fileUrl(row.thumb_path) : null,
  }
  if (row.processed_path && row.processed_width && row.processed_height) {
    asset.processed = {
      path: row.processed_path,
      width: row.processed_width,
      height: row.processed_height,
    }
  }
  if (row.nobg_path) {
    asset.nobg = {
      path: row.nobg_path,
      width: row.nobg_width ?? 0,
      height: row.nobg_height ?? 0,
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

export async function writeThumb(source: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true })
  if (existsSync(dest)) rmSync(dest)
  await execFile('sips', [
    '-Z',
    String(THUMB_EDGE),
    '-s',
    'format',
    'png',
    source,
    '--out',
    dest,
  ])
}

export type EmbeddingRebuild = {
  queued: number
  ids: string[]
}

/** 把向量版本不对的图排进 embed 队列。换向量模型后跑一次。 */
export function rebuildStaleEmbeddings(runner: Runner): EmbeddingRebuild {
  const rows = runner.db
    .prepare(
      `SELECT id FROM image_assets
       WHERE embedding_model_version != ? AND processed_path IS NOT NULL
       ORDER BY created_at`,
    )
    .all(EMBEDDING_MODEL) as Array<{ id: string }>
  const now = runner.now().getTime()
  for (const row of rows) enqueueEmbedJob(runner.db, row.id, now)
  return { queued: rows.length, ids: rows.map((row) => row.id) }
}

export function isEmbeddingStale(asset: ImageAsset): boolean {
  return asset.embeddingModelVersion !== EMBEDDING_MODEL
}

export async function backfillAssetThumbs(
  dataDir: string,
  db: DatabaseSync,
): Promise<number> {
  const root = join(dataDir, 'capture', 'assets')
  if (!existsSync(root)) return 0
  let written = 0
  for (const hash of readdirSync(root)) {
    if (!HASH_RE.test(hash)) continue
    const dir = join(root, hash)
    const source = thumbSource(dir)
    if (!source) continue
    const dest = join(dir, THUMB_NAME)
    await writeThumb(source, dest)
    db.prepare('UPDATE image_assets SET thumb_path = ? WHERE hash = ?').run(
      `capture/assets/${hash}/${THUMB_NAME}`,
      hash,
    )
    written += 1
  }
  return written
}

function thumbSource(dir: string): string | null {
  const processed = join(dir, 'processed.png')
  if (existsSync(processed)) return processed
  const names = readdirSync(dir)
  const original = names.find((name) => name.startsWith('original.'))
  if (original) return join(dir, original)
  const image = names.find(
    (name) => name !== THUMB_NAME && /\.(png|jpe?g|webp)$/i.test(name),
  )
  return image ? join(dir, image) : null
}

export async function pixelSize(
  file: string,
): Promise<{ width: number; height: number }> {
  try {
    const { stdout } = await execFile('sips', [
      '-g',
      'pixelWidth',
      '-g',
      'pixelHeight',
      file,
    ])
    return {
      width: Number(/pixelWidth: (\d+)/.exec(stdout)?.[1]) || 0,
      height: Number(/pixelHeight: (\d+)/.exec(stdout)?.[1]) || 0,
    }
  } catch {
    return { width: 0, height: 0 }
  }
}

type VectorSync = { generation: string; stamps: Map<string, string> }

/** critic 的向量缓存代次 + 本进程已经灌过哪些 id。 */
const vectorSync = new Map<string, VectorSync>()

/** 丢掉「哪些 id 已经灌过」的记忆。测试用，进程重启时也会自动失效。 */
export function clearVectorSync(): void {
  vectorSync.clear()
}

/** 只把 critic 还没有的向量发过去；critic 重启换代次就重灌一遍。 */
async function syncVectors(
  base: string,
  vectors: Record<string, number[]>,
  stamps: Map<string, string>,
): Promise<void> {
  const state = await criticJson<{ generation?: unknown }>(
    base,
    '/image-vector/state',
    {},
  )
  const generation =
    typeof state.generation === 'string' ? state.generation : ''
  let known = vectorSync.get(base)
  if (!known || known.generation !== generation) {
    known = { generation, stamps: new Map() }
    vectorSync.set(base, known)
  }
  const pending: Record<string, number[]> = {}
  for (const [id, vector] of Object.entries(vectors)) {
    if (known.stamps.get(id) === (stamps.get(id) ?? '')) continue
    pending[id] = vector
  }
  const ids = Object.keys(pending)
  if (ids.length === 0) return
  await criticJson(base, '/image-vector', {
    vectors: pending,
    modelVersion: EMBEDDING_MODEL,
  })
  for (const id of ids) known.stamps.set(id, stamps.get(id) ?? '')
}

/** 检索用的向量池：目标图必须在里面，维度不一致的邻居直接丢掉。 */
function poolVectors(
  db: DatabaseSync,
  assets: ImageAsset[],
  targetId: string,
): Record<string, number[]> {
  const stored = loadVectors(
    db,
    EMBEDDING_MODEL,
    assets.map((asset) => asset.id),
  )
  const self = stored.get(targetId)
  if (!self || self.length === 0) {
    const other = storedVector(db, targetId)
    if (other)
      throw new RunnerError(
        `这张图的向量来自 ${other.modelVersion || '未知模型'}，与当前 ${EMBEDDING_MODEL} 不一致；先重建向量`,
        409,
      )
    throw new RunnerError('这张图还没有向量', 409)
  }
  const dim = self.length
  const vectors: Record<string, number[]> = { [targetId]: Array.from(self) }
  for (const [assetId, vec] of stored) {
    if (assetId === targetId || vec.length !== dim) continue
    vectors[assetId] = Array.from(vec)
  }
  return vectors
}

function criticBaseURL(dataDir: string): string {
  try {
    const raw = JSON.parse(
      readFileSync(join(dirname(dataDir), 'config.json'), 'utf8'),
    ) as {
      critic?: { baseURL?: string }
    }
    const url = raw.critic?.baseURL
    if (typeof url === 'string' && url.trim() !== '')
      return url.replace(/\/$/, '')
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
  signal: AbortSignal,
): Promise<{ width: number; height: number }> {
  try {
    return await criticJson<{ width: number; height: number }>(
      base,
      '/prepare',
      { path: originalAbs, out: processedAbs },
      signal,
    )
  } catch (err) {
    if (signal.aborted) throw err
    const message = err instanceof Error ? err.message : String(err)
    if (
      !/404|not found|unexpected token|<!doctype/i.test(message) &&
      !message.includes('prepare')
    ) {
      // 服务在，但预处理本身失败
      if (!/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)) throw err
    }
    return prepareWithPython(dataDir, originalAbs, processedAbs, signal)
  }
}

function prepareWithPython(
  dataDir: string,
  originalAbs: string,
  processedAbs: string,
  signal: AbortSignal,
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
  return execFile(python, ['-c', script], {
    signal,
    timeout: STEP_TIMEOUT_MS,
  }).then(({ stdout }) => {
    const [width, height] = stdout.trim().split(/\s+/).map(Number)
    return { width: width || 0, height: height || 0 }
  })
}

async function criticJson<T>(
  base: string,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const payload = (await res.json()) as { ok?: boolean; error?: string }
  if (!res.ok || payload.ok === false) {
    throw new Error(payload.error || `${path} ${res.status}`)
  }
  return payload as T
}
