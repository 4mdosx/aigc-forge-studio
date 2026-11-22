/**
 * 分组结果落库。
 *
 * 分组天生全局依赖：抽掉 10% 的图重算，ARI 只有 0.55——每次重算有一半边界
 * 会变。所以它不能是「每次查询现算的副产品」，得当成资产存下来，人整理过
 * 的组号才不会下次打开就重排。
 */

import type { DatabaseSync } from 'node:sqlite'

import { transaction } from '../db.ts'
import { RunnerError } from '../errors.ts'
import { loadVectors } from './vectors.ts'

export type GroupInput = { ids: string[]; centerId: string | null }

export type SavedGroups = {
  planId: string
  savedAt: number
  groups: GroupInput[]
  /** 有向量但不在这次分组结果里的图。 */
  ungrouped: string[]
}

export function saveGroups(
  runner: { db: DatabaseSync; now: () => Date },
  modelVersion: string,
  groups: GroupInput[],
): SavedGroups {
  const planId = `${runner.now().getTime().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
  const now = runner.now().getTime()
  const seen = new Set<string>()
  for (const group of groups) {
    for (const id of group.ids) {
      if (seen.has(id)) throw new RunnerError(`分组里有重复的图片: ${id}`)
      seen.add(id)
    }
  }
  transaction(runner.db, () => {
    runner.db.prepare('DELETE FROM image_groups').run()
    runner.db.prepare('DELETE FROM group_plans').run()
    runner.db
      .prepare(
        `INSERT INTO group_plans (plan_id, groups, model_version, centers_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        planId,
        groups.length,
        modelVersion,
        JSON.stringify(groups.map((group) => group.centerId)),
        now,
      )
    const insert = runner.db.prepare(
      `INSERT INTO image_groups (asset_id, plan_id, group_no, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    groups.forEach((group, index) => {
      for (const id of group.ids) insert.run(id, planId, index, now)
    })
  })
  return { planId, savedAt: now, groups, ungrouped: [] }
}

export function loadGroups(runner: {
  db: DatabaseSync
  now: () => Date
}): SavedGroups | null {
  const plan = runner.db
    .prepare(
      `SELECT plan_id, groups, centers_json, created_at FROM group_plans
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as
    | {
        plan_id: string
        groups: number
        centers_json: string
        created_at: number
      }
    | undefined
  if (!plan) return null
  const rows = runner.db
    .prepare(
      `SELECT asset_id, group_no FROM image_groups
       WHERE plan_id = ? ORDER BY group_no, asset_id`,
    )
    .all(plan.plan_id) as Array<{ asset_id: string; group_no: number }>
  let centers: Array<string | null> = []
  try {
    const parsed = JSON.parse(plan.centers_json) as unknown
    if (Array.isArray(parsed))
      centers = parsed.map((value) =>
        typeof value === 'string' ? value : null,
      )
  } catch {
    centers = []
  }
  const groups: GroupInput[] = centers.map((centerId) => ({
    ids: [],
    centerId,
  }))
  for (const row of rows) {
    const bucket = groups[row.group_no]
    if (bucket) bucket.ids.push(row.asset_id)
  }
  const ungrouped = (
    runner.db
      .prepare(
        `SELECT id FROM image_assets
         WHERE id NOT IN (SELECT asset_id FROM image_groups WHERE plan_id = ?)
         ORDER BY created_at DESC`,
      )
      .all(plan.plan_id) as Array<{ id: string }>
  ).map((row) => row.id)
  return {
    planId: plan.plan_id,
    savedAt: plan.created_at,
    groups: groups.filter((group) => group.ids.length > 0),
    ungrouped,
  }
}

export function clearGroups(runner: { db: DatabaseSync }): void {
  transaction(runner.db, () => {
    runner.db.prepare('DELETE FROM image_groups').run()
    runner.db.prepare('DELETE FROM group_plans').run()
  })
}

/** 把计划之外的图挂到最近的组质心。返回新挂上的数量。 */
export function assignUngrouped(
  runner: { db: DatabaseSync; now: () => Date },
  modelVersion: string,
): { assigned: number } {
  const saved = loadGroups(runner)
  if (!saved) throw new RunnerError('还没有保存过分组')
  const members = new Set(saved.groups.flatMap((group) => group.ids))
  const stored = loadVectors(runner.db, modelVersion)
  const candidates: Array<[string, Float32Array]> = []
  for (const [id, vec] of stored) {
    if (!members.has(id)) candidates.push([id, vec])
  }
  if (candidates.length === 0) return { assigned: 0 }
  const dim = [...stored.values()][0]?.length ?? 0
  const centroids = saved.groups.map((group) => {
    const acc = new Float64Array(dim)
    let count = 0
    for (const id of group.ids) {
      const vec = stored.get(id)
      if (!vec || vec.length !== dim) continue
      for (let i = 0; i < dim; i += 1) acc[i] += vec[i]
      count += 1
    }
    if (count === 0) return null
    return normalize(acc)
  })
  const now = runner.now().getTime()
  let assigned = 0
  transaction(runner.db, () => {
    const insert = runner.db.prepare(
      `INSERT INTO image_groups (asset_id, plan_id, group_no, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (asset_id) DO UPDATE SET plan_id = excluded.plan_id,
         group_no = excluded.group_no, updated_at = excluded.updated_at`,
    )
    for (const [id, vec] of candidates) {
      if (vec.length !== dim) continue
      const unit = normalize(Float64Array.from(vec))
      let best = -2
      let bestIndex = -1
      centroids.forEach((centroid, index) => {
        if (!centroid) return
        let dot = 0
        for (let i = 0; i < dim; i += 1) dot += centroid[i] * unit[i]
        if (dot > best) {
          best = dot
          bestIndex = index
        }
      })
      if (bestIndex < 0) continue
      insert.run(id, saved.planId, bestIndex, now)
      assigned += 1
    }
  })
  return { assigned }
}

function normalize(vec: Float64Array): Float64Array {
  let norm = 0
  for (let i = 0; i < vec.length; i += 1) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < vec.length; i += 1) vec[i] /= norm
  return vec
}
