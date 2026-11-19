import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '../db.ts'
import type { Runner } from '../task/queue.ts'
import { createApp } from './app.ts'

test('datasets store a name and image asset ids', async () => {
  const runner = testRunner()
  insertAsset(runner, 'img-1')
  insertAsset(runner, 'img-2')
  const app = createApp(runner)

  const created = await app.request('/datasets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '  pose-a  ' }),
  })
  assert.equal(created.status, 201)
  const dataset = (await created.json()) as {
    id: string
    name: string
    count: number
    assetIds: string[]
  }
  assert.equal(dataset.name, 'pose-a')
  assert.equal(dataset.count, 0)
  assert.deepEqual(dataset.assetIds, [])

  const duplicate = await app.request('/datasets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'pose-a' }),
  })
  assert.equal(duplicate.status, 409)

  const added = await app.request(`/datasets/${dataset.id}/assets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['img-2', 'img-1', 'img-2'] }),
  })
  assert.equal(added.status, 200)
  const withAssets = (await added.json()) as {
    added: number
    count: number
    assetIds: string[]
  }
  assert.equal(withAssets.added, 2)
  assert.equal(withAssets.count, 2)
  assert.deepEqual(withAssets.assetIds, ['img-2', 'img-1'])

  const again = await app.request(`/datasets/${dataset.id}/assets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['img-1'] }),
  })
  assert.equal(again.status, 200)
  assert.equal(((await again.json()) as { added: number }).added, 0)

  const missing = await app.request(`/datasets/${dataset.id}/assets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['missing'] }),
  })
  assert.equal(missing.status, 400)

  const removed = await app.request(`/datasets/${dataset.id}/assets`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['img-2', 'absent'] }),
  })
  assert.equal(removed.status, 200)
  const afterRemove = (await removed.json()) as {
    removed: number
    assetIds: string[]
  }
  assert.equal(afterRemove.removed, 1)
  assert.deepEqual(afterRemove.assetIds, ['img-1'])

  const renamed = await app.request(`/datasets/${dataset.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'pose-b' }),
  })
  assert.equal(renamed.status, 200)
  assert.equal(((await renamed.json()) as { name: string }).name, 'pose-b')

  runner.db.prepare('DELETE FROM image_assets WHERE id = ?').run('img-1')
  const afterImageDelete = await app.request(`/datasets/${dataset.id}`)
  assert.equal(afterImageDelete.status, 200)
  const remaining = (await afterImageDelete.json()) as {
    count: number
    assetIds: string[]
  }
  assert.equal(remaining.count, 0)
  assert.deepEqual(remaining.assetIds, [])

  const listed = await app.request('/datasets')
  assert.equal(listed.status, 200)
  const body = (await listed.json()) as { datasets: Array<{ name: string }> }
  assert.deepEqual(
    body.datasets.map((item) => item.name),
    ['pose-b'],
  )

  const deleted = await app.request(`/datasets/${dataset.id}`, {
    method: 'DELETE',
  })
  assert.equal(deleted.status, 200)
  const gone = await app.request(`/datasets/${dataset.id}`)
  assert.equal(gone.status, 404)
})

test('dataset name is required', async () => {
  const app = createApp(testRunner())
  const created = await app.request('/datasets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '   ' }),
  })
  assert.equal(created.status, 400)
})

function insertAsset(runner: Runner, id: string): void {
  const hash = `${id}${'0'.repeat(64)}`.slice(0, 64)
  runner.db
    .prepare(
      `INSERT INTO image_assets (
        id, status, source_type, original_path, original_width, original_height,
        hash, created_at, updated_at
      ) VALUES (?, 'approved', 'manual', ?, 64, 64, ?, 1, 1)`,
    )
    .run(id, `capture/raw/${id}.png`, hash)
}

function testRunner(): Runner {
  return {
    db: openDatabase(':memory:'),
    clients: [],
    chat: null,
    trainerBaseURL: null,
    dataDir: '/tmp/aigc-runner-test-data',
    timeoutMs: 60_000,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    randomSeed: () => 1,
  }
}
