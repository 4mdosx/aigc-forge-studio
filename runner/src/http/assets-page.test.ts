import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '../db.ts'
import type { Runner } from '../task/queue.ts'
import { createApp } from './app.ts'

test('capture assets page by offset and size', async () => {
  const runner = testRunner()
  insert(runner, 'old', 1, 'approved', 'general', ['pose'])
  insert(runner, 'mid', 2, 'collected', 'explicit', ['pose', 'solo'])
  insert(runner, 'new', 3, 'processed', 'general', ['solo'])
  const app = createApp(runner)

  const page = await app.request('/capture/assets?offset=1&size=1')
  assert.equal(page.status, 200)
  const body = (await page.json()) as {
    total: number
    offset: number
    size: number
    done: number
    processing: number
    unsafe: number
    items: Array<{ id: string; embedding: number[] }>
  }
  assert.equal(body.total, 3)
  assert.equal(body.offset, 1)
  assert.equal(body.size, 1)
  assert.deepEqual(
    body.items.map((item) => item.id),
    ['mid'],
  )
  assert.deepEqual(body.items[0]?.embedding, [])
  assert.equal(body.done, 2)
  assert.equal(body.processing, 1)
  assert.equal(body.unsafe, 1)

  const filtered = await app.request(
    '/capture/assets?offset=0&size=10&status=processed,approved&safe=1&tag=solo',
  )
  assert.equal(filtered.status, 200)
  const narrowed = (await filtered.json()) as {
    total: number
    done: number
    items: Array<{ id: string }>
  }
  assert.equal(narrowed.total, 1)
  assert.equal(narrowed.items[0]?.id, 'new')
  assert.equal(narrowed.done, 2)

  const ids = await app.request('/capture/assets?view=ids&rating=general')
  assert.equal(ids.status, 200)
  assert.deepEqual((await ids.json()) as { ids: string[] }, {
    total: 2,
    ids: ['new', 'old'],
  })

  const tags = await app.request('/capture/assets/tags?safe=1')
  assert.equal(tags.status, 200)
  assert.deepEqual((await tags.json()) as { tags: Array<{ tag: string; count: number }> }, {
    tags: [
      { tag: 'pose', count: 1 },
      { tag: 'solo', count: 1 },
    ],
  })

  const lookup = await app.request('/capture/assets/lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['old', 'missing', 'new'] }),
  })
  assert.equal(lookup.status, 200)
  assert.deepEqual(
    ((await lookup.json()) as { items: Array<{ id: string }> }).items.map((item) => item.id),
    ['old', 'new'],
  )

  const bad = await app.request('/capture/assets?offset=-1&size=1')
  assert.equal(bad.status, 400)
  const huge = await app.request('/capture/assets?size=201')
  assert.equal(huge.status, 400)
})

function insert(
  runner: Runner,
  id: string,
  createdAt: number,
  status: string,
  rating: string,
  tags: string[],
): void {
  const hash = `${id}${'0'.repeat(64)}`.slice(0, 64)
  runner.db
    .prepare(
      `INSERT INTO image_assets (
        id, status, source_type, original_path, original_width, original_height,
        hash, tags_json, rating, created_at, updated_at
      ) VALUES (?, ?, 'manual', ?, 8, 8, ?, ?, ?, ?, ?)`,
    )
    .run(id, status, `capture/raw/${id}.png`, hash, JSON.stringify(tags), rating, createdAt, createdAt)
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
