import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '../db.ts'
import { RunnerError } from '../errors.ts'
import { pageAllJobs, type AllJobsQuery } from './jobs.ts'

const NOW = 1_800_000_000_000

function seed(db: ReturnType<typeof openDatabase>): void {
  const rows = [
    ['g1', 'generate', 'completed', 1000, 1100, 1500, 'run-one', null],
    ['g2', 'generate', 'running', 2000, 2100, null, 'run-two', null],
    ['g3', 'generate', 'failed', 3000, 3050, 3200, 'run-three', null],
    ['p1', 'capture.process', 'done', 4000, 4050, 4300, null, 'asset-1'],
    ['p2', 'capture.process', 'pending', 5000, null, null, null, 'asset-2'],
    ['d1', 'download', 'skipped', 6000, null, null, null, null],
    ['d2', 'download', 'done', 7000, 7100, 7600, null, null],
    ['n1', 'nobg', 'failed', 8000, 8100, 8500, null, 'asset-3'],
  ]
  const insert = db.prepare(
    `INSERT INTO jobs (
       id, kind, status, created_at, started_at, finished_at, task, asset_id,
       label, url, attempts, max_attempts, next_run_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', 0, 3, ?)`,
  )
  for (const [id, kind, status, created, started, finished, task, assetId] of rows) {
    insert.run(id, kind, status, created, started, finished, task, assetId, created)
  }
}

function query(db: ReturnType<typeof openDatabase>, extra: AllJobsQuery = {}) {
  return pageAllJobs(db, extra, NOW)
}

test('统一任务页：分页按活跃优先 + 创建倒序，计数覆盖全部 kind 与状态组', () => {
  const db = openDatabase(':memory:')
  seed(db)
  const page = query(db, { size: '3' })
  assert.equal(page.total, 8)
  assert.equal(page.pages, 3)
  assert.equal(page.size, 3)
  assert.deepEqual(
    page.items.map((item) => item.id),
    ['g2', 'p2', 'n1'],
  )
  assert.deepEqual(page.counts, {
    generate: 3,
    'capture.process': 2,
    download: 2,
    nobg: 1,
  })
  assert.deepEqual(page.statusCounts, {
    all: 8,
    pending: 1,
    running: 1,
    done: 4,
    failed: 2,
  })
  db.close()
})

test('统一任务页：翻页取到后续条目', () => {
  const db = openDatabase(':memory:')
  seed(db)
  const page = query(db, { size: '3', page: '3' })
  assert.equal(page.page, 3)
  assert.deepEqual(
    page.items.map((item) => item.id),
    ['g3', 'g1'],
  )
  db.close()
})

test('统一任务页：按 kind 与状态组筛选', () => {
  const db = openDatabase(':memory:')
  seed(db)
  const generate = query(db, { kind: 'generate' })
  assert.equal(generate.total, 3)
  assert.ok(generate.items.every((item) => item.kind === 'generate'))

  const failed = query(db, { status: 'failed' })
  assert.equal(failed.total, 2)
  assert.deepEqual(
    failed.items.map((item) => item.id).sort(),
    ['g3', 'n1'],
  )

  // done 组归一 Skipped 与 completed：download 下 d1(skipped) + d2(done) = 2 条
  const done = query(db, { kind: 'download', status: 'done' })
  assert.equal(done.total, 2)
  assert.deepEqual(
    done.items.map((item) => item.id).sort(),
    ['d1', 'd2'],
  )
  db.close()
})

test('统一任务页：执行用时来自 started/finished，运行中算到当前时刻', () => {
  const db = openDatabase(':memory:')
  seed(db)
  const { pageAllJobsById } = { pageAllJobsById: (id: string) => query(db).items.find((i) => i.id === id) }
  assert.equal(pageAllJobsById('g1')?.elapsedMs, 400)
  assert.equal(pageAllJobsById('g2')?.elapsedMs, NOW - 2100)
  assert.equal(pageAllJobsById('p2')?.elapsedMs, null)
  assert.equal(pageAllJobsById('d1')?.elapsedMs, null)
  db.close()
})

test('统一任务页：非法 kind / 状态 / 分页参数报错', () => {
  const db = openDatabase(':memory:')
  seed(db)
  assert.throws(() => query(db, { kind: 'bogus' }), RunnerError)
  assert.throws(() => query(db, { status: 'bogus' }), RunnerError)
  assert.throws(() => query(db, { page: '0' }), RunnerError)
  assert.throws(() => query(db, { size: 'abc' }), RunnerError)
  db.close()
})
