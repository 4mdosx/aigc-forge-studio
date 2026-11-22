import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '../db.ts'
import type { Runner } from '../task/queue.ts'
import {
  assignUngrouped,
  clearGroups,
  loadGroups,
  saveGroups,
} from './groups.ts'
import { saveVector } from './vectors.ts'

const MODEL = 'dinov3-cls-224-v1'

test('groups survive a reload and keep their order', () => {
  const { runner, db } = harness()
  insert(db, 'a', [1, 0, 0], 'a')
  insert(db, 'b', [0.9, 0.1, 0], 'b')
  insert(db, 'c', [0, 1, 0], 'c')
  insert(db, 'd', [0, 0.9, 0.1], 'd')

  const saved = saveGroups(runner, MODEL, [
    { ids: ['a', 'b'], centerId: 'a' },
    { ids: ['c', 'd'], centerId: 'd' },
  ])
  const loaded = loadGroups(runner)
  assert.ok(loaded)
  assert.equal(loaded.planId, saved.planId)
  assert.deepEqual(loaded.groups, [
    { ids: ['a', 'b'], centerId: 'a' },
    { ids: ['c', 'd'], centerId: 'd' },
  ])
  assert.deepEqual(loaded.ungrouped, [])
})

test('new images show up as ungrouped until assigned to the nearest centroid', () => {
  const { runner, db } = harness()
  insert(db, 'a', [1, 0, 0], 'a')
  insert(db, 'b', [0.9, 0.1, 0], 'b')
  insert(db, 'c', [0, 1, 0], 'c')
  insert(db, 'd', [0, 0.9, 0.1], 'd')
  insert(db, 'fresh', [0.95, 0.05, 0], 'e')

  saveGroups(runner, MODEL, [
    { ids: ['a', 'b'], centerId: 'a' },
    { ids: ['c', 'd'], centerId: 'd' },
  ])
  const before = loadGroups(runner)
  assert.deepEqual(before?.ungrouped, ['fresh'])

  assert.deepEqual(assignUngrouped(runner, MODEL), { assigned: 1 })
  const after = loadGroups(runner)
  assert.deepEqual(after?.ungrouped, [])
  assert.deepEqual(after?.groups[0]?.ids.sort(), ['a', 'b', 'fresh'])
})

test('clearing removes the plan and rejects assigning without one', () => {
  const { runner, db } = harness()
  insert(db, 'a', [1, 0, 0], 'a')
  saveGroups(runner, MODEL, [{ ids: ['a'], centerId: 'a' }])
  clearGroups(runner)
  assert.equal(loadGroups(runner), null)
  assert.throws(() => assignUngrouped(runner, MODEL), /还没有保存过分组/)
})

test('duplicate ids across groups are rejected', () => {
  const { runner, db } = harness()
  insert(db, 'a', [1, 0, 0], 'a')
  assert.throws(
    () =>
      saveGroups(runner, MODEL, [
        { ids: ['a'], centerId: 'a' },
        { ids: ['a'], centerId: 'a' },
      ]),
    /重复/,
  )
})

function harness(): { runner: Runner; db: Runner['db'] } {
  const db = openDatabase(':memory:')
  const runner = {
    db,
    dataDir: '/tmp',
    now: () => new Date('2026-01-02T00:00:00.000Z'),
  } as Runner
  return { runner, db }
}

function insert(
  db: Runner['db'],
  id: string,
  vector: number[],
  hashChar: string,
): void {
  const hash = hashChar.repeat(64)
  db.prepare(
    `INSERT INTO image_assets (
      id, status, source_type, source_url, img_url,
      original_path, original_width, original_height, hash,
      tags_json, embedding_json, tags_model_version, embedding_model_version,
      reviewed_at, created_at, updated_at
    ) VALUES (?, 'processed', 'manual', '', '', ?, 8, 8, ?, '[]', '[]', '', ?, 0, 1, 2)`,
  ).run(id, `capture/raw/${hash}/original.jpg`, hash, MODEL)
  saveVector(db, id, MODEL, vector, 2)
}
