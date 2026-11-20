import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openDatabase } from '../db.ts'
import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'
import { createApp } from '../http/app.ts'
import { nearestAssets } from './asset.ts'

test('nearest sends usable vectors and returns critic order with thumbs', async () => {
  const { runner, db } = harness()
  insert(db, 'a', [1, 0], 'a')
  insert(db, 'b', [0.9, 0.1], 'b')
  insert(db, 'zero', [0, 0], 'c')
  insert(db, 'short', [1], 'd')
  const calls: Array<{ path: string; body: { vectors?: Record<string, number[]>; id?: string; k?: number; order?: string } }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body)) as {
      vectors?: Record<string, number[]>
      id?: string
      k?: number
      order?: string
    }
    calls.push({ path: new URL(url).pathname, body })
    if (url.endsWith('/nearest')) {
      return Response.json({
        ok: true,
        id: 'a',
        neighbors: [{ id: 'b', cosine: 0.99388, l2: 0.14142 }],
      })
    }
    return Response.json({ ok: true, count: 2, dim: 2 })
  }) as typeof fetch
  try {
    const app = createApp(runner)
    const res = await app.request('/capture/assets/a/nearest')
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      id: string
      neighbors: Array<{ id: string; cosine: number; thumbUrl: string | null }>
    }
    assert.equal(body.id, 'a')
    assert.equal(body.neighbors.length, 1)
    assert.equal(body.neighbors[0]?.id, 'b')
    assert.equal(body.neighbors[0]?.cosine, 0.99388)
    assert.match(body.neighbors[0]?.thumbUrl ?? '', /bbbb/)
    assert.deepEqual(calls.map((call) => call.path), ['/image-vector', '/image-vector/nearest'])
    assert.deepEqual(Object.keys(calls[0]?.body.vectors ?? {}).sort(), ['a', 'b'])
    assert.equal(calls[1]?.body.id, 'a')
    assert.equal(calls[1]?.body.k, 10)
    assert.equal(calls[1]?.body.order, 'near')

    const narrowed = await app.request('/capture/assets/a/nearest?k=4')
    assert.equal(narrowed.status, 200)
    assert.equal(calls.at(-1)?.body.k, 4)

    const bad = await app.request('/capture/assets/a/nearest?k=0')
    assert.equal(bad.status, 400)

    const far = await app.request('/capture/assets/a/nearest?order=far')
    assert.equal(far.status, 200)
    assert.equal(calls.at(-1)?.body.order, 'far')
    assert.equal(calls.at(-1)?.body.k, 10)

    const badOrder = await app.request('/capture/assets/a/nearest?order=sideways')
    assert.equal(badOrder.status, 400)
  } finally {
    globalThis.fetch = original
  }
})

test('nearest limits the vector table to the requested ids', async () => {
  const { runner, db } = harness()
  insert(db, 'a', [1, 0], 'a')
  insert(db, 'b', [0.9, 0.1], 'b')
  insert(db, 'c', [0, 1], 'c')
  const calls: Array<{ path: string; body: { vectors?: Record<string, number[]> } }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body)) as { vectors?: Record<string, number[]> }
    calls.push({ path: new URL(url).pathname, body })
    if (url.endsWith('/nearest')) {
      return Response.json({ ok: true, id: 'a', neighbors: [{ id: 'b', cosine: 0.99, l2: 0.1 }] })
    }
    return Response.json({ ok: true, count: 2, dim: 2 })
  }) as typeof fetch
  try {
    const app = createApp(runner)
    const res = await app.request('/capture/assets/a/nearest?k=5&order=far&ids=b')
    assert.equal(res.status, 200)
    assert.deepEqual(Object.keys(calls[0]?.body.vectors ?? {}).sort(), ['a', 'b'])
    db.prepare(`UPDATE image_assets SET status = 'approved' WHERE id = 'c'`).run()
    const scoped = await app.request('/capture/assets/a/nearest?status=processed')
    assert.equal(scoped.status, 200)
    assert.deepEqual(Object.keys(calls.at(-2)?.body.vectors ?? {}).sort(), ['a', 'b'])
    const duplicate = await app.request('/capture/assets/a/nearest?ids=b,b')
    assert.equal(duplicate.status, 400)
  } finally {
    globalThis.fetch = original
  }
})

test('groups divides usable images into nearly equal groups', async () => {
  const { runner, db } = harness()
  insert(db, 'a', [1, 0], 'a')
  insert(db, 'b', [0.2, 1], 'b')
  insert(db, 'c', [0.8, 0.2], 'c')
  insert(db, 'zero', [0, 0], 'd')
  const app = createApp(runner)
  const res = await app.request('/capture/assets/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['a', 'b', 'c', 'zero'], groups: 2 }),
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { groups: Array<{ ids: string[] }>; skipped: string[] }
  assert.deepEqual(body.skipped, ['zero'])
  assert.deepEqual(body.groups.map((group) => group.ids.length), [2, 1])
  assert.deepEqual(body.groups.flatMap((group) => group.ids).sort(), ['a', 'b', 'c'])

  const tooMany = await app.request('/capture/assets/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['a', 'b'], groups: 4 }),
  })
  assert.equal(tooMany.status, 400)
})

test('nearest rejects a missing image and an image without a vector', async () => {
  const { runner, db } = harness()
  insert(db, 'empty', [], 'e')
  await assert.rejects(nearestAssets(runner, 'missing'), (err: unknown) => {
    assert.ok(err instanceof RunnerError)
    assert.equal(err.status, 404)
    return true
  })
  await assert.rejects(nearestAssets(runner, 'empty'), /还没有向量/)
})

test('nearest surfaces a critic failure', async () => {
  const { runner, db } = harness()
  insert(db, 'a', [1, 0], 'a')
  const original = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ ok: false, error: 'critic down' }, { status: 500 })) as typeof fetch
  try {
    await assert.rejects(nearestAssets(runner, 'a'), (err: unknown) => {
      assert.ok(err instanceof RunnerError)
      assert.equal(err.status, 502)
      assert.match(err.message, /critic down/)
      return true
    })
  } finally {
    globalThis.fetch = original
  }
})

function harness(): { runner: Runner; db: Runner['db'] } {
  const db = openDatabase(':memory:')
  const runner = {
    db,
    dataDir: mkdtempSync(join(tmpdir(), 'capture-nearest-')),
    now: () => new Date('2026-01-02T00:00:00.000Z'),
  } as Runner
  return { runner, db }
}

function insert(db: Runner['db'], id: string, embedding: number[], hashChar: string): void {
  const hash = hashChar.repeat(64)
  db.prepare(
    `INSERT INTO image_assets (
      id, status, source_type, source_url, img_url,
      original_path, original_width, original_height, hash, thumb_path,
      tags_json, embedding_json, tags_model_version, embedding_model_version,
      reviewed_at, created_at, updated_at
    ) VALUES (?, 'processed', 'manual', '', '', ?, 8, 8, ?, ?, '[]', ?, '', '', 0, 1, 2)`,
  ).run(
    id,
    `capture/raw/${hash}/original.jpg`,
    hash,
    `capture/assets/${hash}/thumb.png`,
    JSON.stringify(embedding),
  )
}
