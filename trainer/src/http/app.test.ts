import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, test } from 'node:test'

import { openDatabase } from '../db.ts'
import { createApp } from './app.ts'
import { buildRoots } from '../roots.ts'
import type { Trainer } from '../download/manager.ts'

let trainer: Trainer
let tmp: string
let app: ReturnType<typeof createApp>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'trainer-up-'))
  const db = openDatabase(join(tmp, 'test.sqlite'))
  trainer = {
    db,
    roots: buildRoots({
      models: join(tmp, 'models'),
      training: join(tmp, 'training'),
    }),
    controllers: new Map(),
    runs: new Map(),
    now: () => new Date(),
  }
  app = createApp(trainer)
})

afterEach(() => {
  trainer.db.close()
})

test('upload streams a body to disk with sha256', async () => {
  const payload = Buffer.alloc(300_000)
  for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251
  const expected = createHash('sha256').update(payload).digest('hex')

  const response = await app.request(
    `http://x/upload?root=models&path=${encodeURIComponent('checkpoints/sub/m.bin')}`,
    { method: 'POST', body: new Uint8Array(payload) },
  )
  assert.equal(response.status, 201)
  const json = (await response.json()) as {
    path: string
    size: number
    sha256: string
  }
  assert.equal(json.path, 'models/checkpoints/sub/m.bin')
  assert.equal(json.size, payload.length)
  assert.equal(json.sha256, expected)
  const written = readFileSync(
    join(tmp, 'models', 'checkpoints', 'sub', 'm.bin'),
  )
  assert.ok(written.equals(payload))
})

test('upload rejects missing root, unknown root, bad path, missing body', async () => {
  const body = new Uint8Array([1, 2, 3])
  const cases: [string, RequestInit][] = [
    [`http://x/upload?path=a.bin`, { method: 'POST', body }],
    [`http://x/upload?root=nope&path=a.bin`, { method: 'POST', body }],
    [`http://x/upload?root=models&path=../a.bin`, { method: 'POST', body }],
    [`http://x/upload?root=models&path=a.bin`, { method: 'POST' }],
  ]
  for (const [url, init] of cases) {
    const response = await app.request(url, init)
    assert.ok(response.status >= 400, `should reject: ${url}`)
  }
})

test('GET /files streams stored bytes back', async () => {
  const payload = Buffer.from('hello trainer')
  await app.request('http://x/upload?root=models&path=greet.txt', {
    method: 'POST',
    body: new Uint8Array(payload),
  })
  const response = await app.request(
    'http://x/files?root=models&path=greet.txt',
  )
  assert.equal(response.status, 200)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.ok(bytes.equals(payload))
})

test('GET /health and unknown routes', async () => {
  assert.equal((await app.request('http://x/health')).status, 200)
  assert.equal((await app.request('http://x/zzz')).status, 404)
})

test('roots API is read-only view of config', async () => {
  const list = (await (
    await app.request('http://x/roots')
  ).json()) as { roots: Record<string, string> }
  assert.equal(list.roots.models, join(tmp, 'models'))
  assert.equal(list.roots.training, join(tmp, 'training'))
  // config 写死后：写接口不应存在（404）
  const put = await app.request('http://x/roots/training', {
    method: 'PUT',
    body: JSON.stringify({ path: '/tmp/zzz' }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(put.status, 404)
  const del = await app.request('http://x/roots/training', { method: 'DELETE' })
  assert.equal(del.status, 404)
})

test('downloads API: create, poll, idempotent re-post over HTTP', async () => {
  const payload = Buffer.alloc(2048, 7)
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-length': payload.length })
    res.end(payload)
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const url = `http://127.0.0.1:${address.port}/f.bin`
  try {
    const first = await app.request('http://x/downloads', {
      method: 'POST',
      body: JSON.stringify({ url, root: 'models', path: 'http-api.bin' }),
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(first.status, 201)
    const firstJson = (await first.json()) as {
      outcome: string
      download: { id: string }
    }
    assert.equal(firstJson.outcome, 'created')

    // 轮询到完成
    let status = ''
    for (let i = 0; i < 100; i += 1) {
      const res = await app.request(
        `http://x/downloads/${firstJson.download.id}`,
      )
      status = ((await res.json()) as { status: string }).status
      if (status === 'completed') break
      await new Promise((ok) => setTimeout(ok, 25))
    }
    assert.equal(status, 'completed')

    const second = await app.request('http://x/downloads', {
      method: 'POST',
      body: JSON.stringify({ url, root: 'models', path: 'http-api.bin' }),
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(second.status, 200)
    const secondJson = (await second.json()) as { outcome: string }
    assert.equal(secondJson.outcome, 'deduped')
  } finally {
    await new Promise((ok) => server.close(ok))
  }
})
