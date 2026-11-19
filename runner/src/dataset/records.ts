import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { transaction } from '../db.ts'
import { RunnerError } from '../errors.ts'

// 训练数据集：一个名字对应一组 image_assets.id。
// 成员表跟着图片删除级联，导出时读 assetIds 即可。

const NAME_MAX = 64
const IDS_MAX = 5000

export interface Dataset {
  id: string
  name: string
  count: number
  createdAt: number
  updatedAt: number
  assetIds: string[]
}

interface DatasetRow {
  id: string
  name: string
  created_at: number
  updated_at: number
  asset_id: string | null
}

export function datasetNameOf(value: unknown): string {
  if (typeof value !== 'string') throw new RunnerError('name 必须是字符串')
  const name = value.trim()
  if (name === '') throw new RunnerError('name 不能为空')
  if (name.length > NAME_MAX)
    throw new RunnerError(`name 最长 ${NAME_MAX} 个字符`)
  if (/[\u0000-\u001f]/.test(name))
    throw new RunnerError('name 不能包含控制字符')
  return name
}

export function assetIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) throw new RunnerError('ids 必须是图片 id 数组')
  if (value.length === 0) throw new RunnerError('ids 不能为空')
  if (value.length > IDS_MAX) throw new RunnerError(`一次最多 ${IDS_MAX} 张`)
  const seen = new Set<string>()
  const ids: string[] = []
  for (const id of value) {
    if (typeof id !== 'string' || id === '') {
      throw new RunnerError('ids 里的图片 id 必须是非空字符串')
    }
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

export function listDatasets(db: DatabaseSync): Dataset[] {
  const rows = db
    .prepare(
      `SELECT d.id, d.name, d.created_at, d.updated_at, a.asset_id
       FROM datasets d
       LEFT JOIN dataset_assets a ON a.dataset_id = d.id
       ORDER BY d.created_at, d.id, a.rowid`,
    )
    .all() as unknown as DatasetRow[]
  return groupDatasets(rows)
}

export function datasetById(db: DatabaseSync, id: string): Dataset {
  const rows = db
    .prepare(
      `SELECT d.id, d.name, d.created_at, d.updated_at, a.asset_id
       FROM datasets d
       LEFT JOIN dataset_assets a ON a.dataset_id = d.id
       WHERE d.id = ?
       ORDER BY a.rowid`,
    )
    .all(id) as unknown as DatasetRow[]
  const dataset = groupDatasets(rows)[0]
  if (!dataset) throw new RunnerError('数据集不存在', 404)
  return dataset
}

export function createDataset(
  db: DatabaseSync,
  name: string,
  now: number,
): Dataset {
  const id = randomUUID()
  try {
    db.prepare(
      'INSERT INTO datasets (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run(id, name, now, now)
  } catch (err) {
    if (uniqueConflict(err)) throw new RunnerError('数据集名称已存在', 409)
    throw err
  }
  return {
    id,
    name,
    count: 0,
    createdAt: now,
    updatedAt: now,
    assetIds: [],
  }
}

export function renameDataset(
  db: DatabaseSync,
  id: string,
  name: string,
  now: number,
): Dataset {
  const current = datasetById(db, id)
  if (current.name === name) return current
  try {
    db.prepare('UPDATE datasets SET name = ?, updated_at = ? WHERE id = ?').run(
      name,
      now,
      id,
    )
  } catch (err) {
    if (uniqueConflict(err)) throw new RunnerError('数据集名称已存在', 409)
    throw err
  }
  return datasetById(db, id)
}

export function deleteDataset(db: DatabaseSync, id: string): void {
  const result = db.prepare('DELETE FROM datasets WHERE id = ?').run(id)
  if (changed(result) === 0) throw new RunnerError('数据集不存在', 404)
}

export function addDatasetAssets(
  db: DatabaseSync,
  datasetId: string,
  ids: string[],
  now: number,
): { dataset: Dataset; added: number } {
  assertDataset(db, datasetId)
  assertAssets(db, ids)
  const insert = db.prepare(
    `INSERT INTO dataset_assets (dataset_id, asset_id, added_at)
     VALUES (?, ?, ?)
     ON CONFLICT (dataset_id, asset_id) DO NOTHING`,
  )
  let added = 0
  transaction(db, () => {
    for (const assetId of ids) {
      added += changed(insert.run(datasetId, assetId, now))
    }
    if (added > 0) touch(db, datasetId, now)
  })
  return { dataset: datasetById(db, datasetId), added }
}

export function removeDatasetAssets(
  db: DatabaseSync,
  datasetId: string,
  ids: string[],
  now: number,
): { dataset: Dataset; removed: number } {
  assertDataset(db, datasetId)
  const remove = db.prepare(
    'DELETE FROM dataset_assets WHERE dataset_id = ? AND asset_id = ?',
  )
  let removed = 0
  transaction(db, () => {
    for (const assetId of ids) {
      removed += changed(remove.run(datasetId, assetId))
    }
    if (removed > 0) touch(db, datasetId, now)
  })
  return { dataset: datasetById(db, datasetId), removed }
}

function groupDatasets(rows: DatasetRow[]): Dataset[] {
  const datasets: Dataset[] = []
  const index = new Map<string, Dataset>()
  for (const row of rows) {
    let dataset = index.get(row.id)
    if (!dataset) {
      dataset = {
        id: row.id,
        name: row.name,
        count: 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        assetIds: [],
      }
      index.set(row.id, dataset)
      datasets.push(dataset)
    }
    if (row.asset_id) {
      dataset.assetIds.push(row.asset_id)
      dataset.count += 1
    }
  }
  return datasets
}

function assertDataset(db: DatabaseSync, id: string): void {
  const row = db.prepare('SELECT id FROM datasets WHERE id = ?').get(id)
  if (!row) throw new RunnerError('数据集不存在', 404)
}

function assertAssets(db: DatabaseSync, ids: string[]): void {
  const select = db.prepare('SELECT id FROM image_assets WHERE id = ?')
  const missing: string[] = []
  for (const id of ids) {
    if (!select.get(id)) missing.push(id)
  }
  if (missing.length === 0) return
  const preview = missing.slice(0, 3).join('、')
  throw new RunnerError(
    missing.length === 1
      ? `图片不存在: ${preview}`
      : `${missing.length} 张图片不存在: ${preview}`,
    400,
  )
}

function touch(db: DatabaseSync, id: string, now: number): void {
  db.prepare('UPDATE datasets SET updated_at = ? WHERE id = ?').run(now, id)
}

function changed(result: { changes: number | bigint }): number {
  return Number(result.changes)
}

function uniqueConflict(err: unknown): boolean {
  return (
    err instanceof Error && err.message.includes('UNIQUE constraint failed')
  )
}
