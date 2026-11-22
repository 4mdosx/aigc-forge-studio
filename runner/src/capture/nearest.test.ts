import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openDatabase } from '../db.ts'
import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'
import { createApp } from '../http/app.ts'
import {
  EMBEDDING_MODEL,
  clearVectorSync,
  nearestAssets,
  rebuildStaleEmbeddings,
} from './asset.ts'
import { saveVector } from './vectors.ts'

test('nearest sends usable vectors and returns critic order with thumbs', async () => {
  const { runner, db } = harness()
  insert(db, 'a', [1, 0], 'a')
  insert(db, 'b', [0.9, 0.1], 'b')
  insert(db, 'zero', [0, 0], 'c')
  insert(db, 'short', [1], 'd')
  const calls: Array<{
    path: string
    body: {
      vectors?: Record<string, number[]>
      modelVersion?: string
      id?: string
      k?: number
      order?: string
      ids?: string[]
    }
  }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body)) as {
      vectors?: Record<string, number[]>
      modelVersion?: string
      id?: string
      k?: number
      order?: string
      ids?: string[]
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
    assert.deepEqual(
      calls.map((call) => call.path),
      ['/image-vector/state', '/image-vector', '/image-vector/nearest'],
    )
    const sync = calls.find((call) => call.path === '/image-vector')
    const near = calls.find((call) => call.path === '/image-vector/nearest')
    assert.deepEqual(Object.keys(sync?.body.vectors ?? {}).sort(), ['a', 'b'])
    assert.equal(sync?.body.modelVersion, EMBEDDING_MODEL)
    assert.equal(near?.body.id, 'a')
    assert.equal(near?.body.k, 10)
    assert.equal(near?.body.order, 'near')
    assert.deepEqual(near?.body.ids?.sort(), ['a', 'b'])

    const narrowed = await app.request('/capture/assets/a/nearest?k=4')
    assert.equal(narrowed.status, 200)
    assert.equal(calls.at(-1)?.body.k, 4)
    // 同一批向量不会重复发送
    assert.equal(
      calls.filter((call) => call.path === '/image-vector').length,
      1,
    )

    const bad = await app.request('/capture/assets/a/nearest?k=0')
    assert.equal(bad.status, 400)

    const far = await app.request('/capture/assets/a/nearest?order=far')
    assert.equal(far.status, 200)
    assert.equal(calls.at(-1)?.body.order, 'far')
    assert.equal(calls.at(-1)?.body.k, 10)

    const badOrder = await app.request(
      '/capture/assets/a/nearest?order=sideways',
    )
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
  const calls: Array<{
    path: string
    body: { vectors?: Record<string, number[]>; ids?: string[] }
  }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body)) as {
      vectors?: Record<string, number[]>
      ids?: string[]
    }
    calls.push({ path: new URL(url).pathname, body })
    if (url.endsWith('/nearest')) {
      return Response.json({
        ok: true,
        id: 'a',
        neighbors: [{ id: 'b', cosine: 0.99, l2: 0.1 }],
      })
    }
    return Response.json({ ok: true, count: 2, dim: 2, generation: 'gen-1' })
  }) as typeof fetch
  try {
    const app = createApp(runner)
    const res = await app.request(
      '/capture/assets/a/nearest?k=5&order=far&ids=b',
    )
    assert.equal(res.status, 200)
    const syncs = () => calls.filter((call) => call.path === '/image-vector')
    const nearestCalls = () =>
      calls.filter((call) => call.path === '/image-vector/nearest')
    assert.deepEqual(Object.keys(syncs()[0]?.body.vectors ?? {}).sort(), [
      'a',
      'b',
    ])
    assert.equal(res.status, 200)
    db.prepare(
      `UPDATE image_assets SET status = 'approved' WHERE id = 'c'`,
    ).run()
    const scoped = await app.request(
      '/capture/assets/a/nearest?status=processed',
    )
    assert.equal(scoped.status, 200)
    // a、b 已经灌过，第二次请求不该再发向量
    assert.equal(syncs().length, 1)
    assert.deepEqual(nearestCalls().at(-1)?.body.ids?.sort(), ['a', 'b'])
    const duplicate = await app.request('/capture/assets/a/nearest?ids=b,b')
    assert.equal(duplicate.status, 400)
  } finally {
    globalThis.fetch = original
  }
})

test('groups divides usable images into clusters with medoid centers', async () => {
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
  const body = (await res.json()) as {
    groups: Array<{ ids: string[]; centerId: string | null }>
    skipped: string[]
    stale: string[]
    balance: string
  }
  assert.deepEqual(body.skipped, ['zero'])
  assert.deepEqual(body.stale, [])
  assert.equal(body.balance, 'cluster')
  assert.deepEqual(
    body.groups.map((group) => group.ids.length),
    [2, 1],
  )
  assert.deepEqual(body.groups.flatMap((group) => group.ids).sort(), [
    'a',
    'b',
    'c',
  ])
  for (const group of body.groups) {
    assert.ok(group.centerId)
    assert.ok(group.ids.includes(group.centerId as string))
  }

  const even = await app.request('/capture/assets/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['a', 'b', 'c'], groups: 2, balance: 'even' }),
  })
  assert.equal(even.status, 200)
  assert.equal(((await even.json()) as { balance: string }).balance, 'even')

  const tooMany = await app.request('/capture/assets/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['a', 'b'], groups: 4 }),
  })
  assert.equal(tooMany.status, 400)

  const badBalance = await app.request('/capture/assets/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['a', 'b'], groups: 2, balance: 'nearest' }),
  })
  assert.equal(badBalance.status, 400)
})

test('stale vectors are kept out of grouping and reported', async () => {
  const { runner, db } = harness()
  insert(db, 'a', [1, 0], 'a')
  insert(db, 'b', [0.9, 0.1], 'b')
  insert(db, 'old', [1, 0], 'c', 'style-embedder-v3')
  const app = createApp(runner)
  const res = await app.request('/capture/assets/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['a', 'b', 'old'], groups: 2 }),
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { skipped: string[]; stale: string[] }
  assert.deepEqual(body.skipped, ['old'])
  assert.deepEqual(body.stale, ['old'])
})

test('nearest refuses a stale target and ignores stale neighbours', async () => {
  const { runner, db } = harness()
  insert(db, 'a', [1, 0], 'a')
  insert(db, 'old', [0.9, 0.1], 'b', 'style-embedder-v3')
  const calls: Array<{ path: string; vectors?: Record<string, number[]> }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    calls.push({
      path: new URL(url).pathname,
      ...(JSON.parse(String(init?.body)) as {
        vectors?: Record<string, number[]>
      }),
    })
    if (url.endsWith('/nearest')) {
      return Response.json({ ok: true, id: 'a', neighbors: [] })
    }
    return Response.json({
      ok: true,
      count: 1,
      dim: 2,
      generation: 'gen-stale',
    })
  }) as typeof fetch
  try {
    const app = createApp(runner)
    const res = await app.request('/capture/assets/a/nearest')
    assert.equal(res.status, 200)
    const sync = calls.find((call) => call.path === '/image-vector')
    assert.deepEqual(Object.keys(sync?.vectors ?? {}), ['a'])
    const stale = await app.request('/capture/assets/old/nearest')
    assert.equal(stale.status, 409)
    const body = (await stale.json()) as { error: string }
    assert.match(body.error, /不一致/)
  } finally {
    globalThis.fetch = original
  }
})

test('rebuild queues embed jobs for stale and empty vectors only', () => {
  const { runner, db } = harness()
  insert(db, 'a', [1, 0], 'a')
  insert(db, 'old', [1, 0], 'b', 'style-embedder-v3')
  insert(db, 'empty', [], 'c')
  const result = rebuildStaleEmbeddings(runner)
  assert.deepEqual(result.ids.sort(), ['empty', 'old'])
  const jobs = (
    db
      .prepare(
        `SELECT asset_id, step FROM jobs WHERE kind = 'capture.process' ORDER BY asset_id`,
      )
      .all() as Array<{ asset_id: string; step: string }>
  ).map((row) => ({ asset_id: row.asset_id, step: row.step }))
  assert.deepEqual(jobs, [
    { asset_id: 'empty', step: 'embed' },
    { asset_id: 'old', step: 'embed' },
  ])
  assert.deepEqual(rebuildStaleEmbeddings(runner).ids.sort(), ['empty', 'old'])
  assert.equal(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM jobs WHERE kind = 'capture.process'`,
        )
        .get() as { n: number }
    ).n,
    2,
  )
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
  globalThis.fetch = (async () =>
    Response.json(
      { ok: false, error: 'critic down' },
      { status: 500 },
    )) as typeof fetch
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
  clearVectorSync()
  const db = openDatabase(':memory:')
  const runner = {
    db,
    dataDir: mkdtempSync(join(tmpdir(), 'capture-nearest-')),
    now: () => new Date('2026-01-02T00:00:00.000Z'),
  } as Runner
  return { runner, db }
}

function insert(
  db: Runner['db'],
  id: string,
  embedding: number[],
  hashChar: string,
  version = EMBEDDING_MODEL,
): void {
  const hash = hashChar.repeat(64)
  const model = embedding.length === 0 ? '' : version
  db.prepare(
    `INSERT INTO image_assets (
      id, status, source_type, source_url, img_url,
      original_path, original_width, original_height, hash, thumb_path,
      processed_path, processed_width, processed_height,
      tags_json, embedding_json, tags_model_version, embedding_model_version,
      reviewed_at, created_at, updated_at
    ) VALUES (?, 'processed', 'manual', '', '', ?, 8, 8, ?, ?,
      ?, 8, 8, '[]', '[]', '', ?, 0, 1, 2)`,
  ).run(
    id,
    `capture/raw/${hash}/original.jpg`,
    hash,
    `capture/assets/${hash}/thumb.png`,
    `capture/assets/${hash}/processed.png`,
    model,
  )
  if (embedding.length > 0) saveVector(db, id, model, embedding, 2)
}
