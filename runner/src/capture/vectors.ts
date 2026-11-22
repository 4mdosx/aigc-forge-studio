/**
 * 图片向量的持久层。
 *
 * 向量单独一张表：1280 维写成 JSON 是 10KB 一行文本，而 image_assets 的列表查询
 * 会走 SELECT *，把它们全捞出来纯属浪费。这里存 f32 二进制，5KB/图，
 * 1824 张 9MB，读回来几乎零解析。
 */

import type { DatabaseSync } from 'node:sqlite'

const FLOAT_BYTES = 4

export type StoredVector = {
  modelVersion: string
  vec: Float32Array
}

export function encodeVector(values: readonly number[]): Buffer {
  const typed = new Float32Array(values)
  return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength)
}

export function decodeVector(raw: Uint8Array): Float32Array {
  // SQLite 给的 Uint8Array 不保证对齐，先拷一份再按 float32 视图读。
  const copy = new Uint8Array(raw)
  if (copy.byteLength % FLOAT_BYTES !== 0) {
    throw new Error(`向量 BLOB 长度 ${copy.byteLength} 不是 4 的倍数`)
  }
  return new Float32Array(
    copy.buffer,
    copy.byteOffset,
    copy.byteLength / FLOAT_BYTES,
  )
}

export function saveVector(
  db: DatabaseSync,
  id: string,
  modelVersion: string,
  values: readonly number[],
  now: number,
): void {
  if (values.length === 0) throw new Error('向量不能为空')
  if (values.some((value) => !Number.isFinite(value)))
    throw new Error('向量含非有限值')
  db.prepare(
    `INSERT INTO image_vectors (asset_id, model_version, dim, vec, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (asset_id) DO UPDATE SET
       model_version = excluded.model_version,
       dim = excluded.dim,
       vec = excluded.vec,
       updated_at = excluded.updated_at`,
  ).run(id, modelVersion, values.length, encodeVector(values), now)
}

export function deleteVector(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM image_vectors WHERE asset_id = ?').run(id)
}

export function storedVector(
  db: DatabaseSync,
  id: string,
): StoredVector | null {
  const row = db
    .prepare('SELECT model_version, vec FROM image_vectors WHERE asset_id = ?')
    .get(id) as { model_version: string; vec: Uint8Array } | undefined
  if (!row) return null
  return { modelVersion: row.model_version, vec: decodeVector(row.vec) }
}

/**
 * 当前模型的全部向量。分组和检索都从这里取，不再碰 image_assets。
 * 全零向量在这里就丢掉：critic 会拒收，混进去只会让检索莫名报错。
 */
export function loadVectors(
  db: DatabaseSync,
  modelVersion: string,
  ids?: readonly string[],
): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>()
  if (ids && ids.length === 0) return out
  const rows = (
    ids
      ? db
          .prepare(
            `SELECT asset_id, vec FROM image_vectors
             WHERE model_version = ? AND asset_id IN (${ids.map(() => '?').join(', ')})`,
          )
          .all(modelVersion, ...ids)
      : db
          .prepare(
            'SELECT asset_id, vec FROM image_vectors WHERE model_version = ?',
          )
          .all(modelVersion)
  ) as Array<{ asset_id: string; vec: Uint8Array }>
  for (const row of rows) {
    const vec = decodeVector(row.vec)
    if (isZero(vec)) continue
    out.set(row.asset_id, vec)
  }
  return out
}

function isZero(vec: Float32Array): boolean {
  for (let i = 0; i < vec.length; i += 1) if (vec[i] !== 0) return false
  return vec.length > 0
}

/** 每个图的向量版本，用来算「哪些图需要重建」。 */
export function vectorVersions(db: DatabaseSync): Map<string, string> {
  const rows = db
    .prepare('SELECT asset_id, model_version FROM image_vectors')
    .all() as Array<{ asset_id: string; model_version: string }>
  return new Map(rows.map((row) => [row.asset_id, row.model_version]))
}
