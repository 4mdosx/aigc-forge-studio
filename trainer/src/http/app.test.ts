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

test('DELETE /files: single file, glob cleanup, refuses bare directory', async () => {
  // 造两个 npz + 一个 txt + 一个子目录里的 npz（不应被波及）
  for (const p of ['ds/a.npz', 'ds/b.npz', 'ds/keep.txt', 'ds/sub/c.npz']) {
    await app.request(`http://x/upload?root=training&path=${encodeURIComponent(p)}`, {
      method: 'POST',
      body: new Uint8Array([1]),
    })
  }

  // 目录 + glob：只删平层匹配文件
  const res = await app.request(
    'http://x/files?root=training&path=ds&glob=*.npz',
    { method: 'DELETE' },
  )
  assert.equal(res.status, 200)
  const json = (await res.json()) as { deleted: string[]; count: number }
  assert.equal(json.count, 2)
  assert.deepEqual(json.deleted.sort(), ['training/ds/a.npz', 'training/ds/b.npz'])
  // keep.txt 与子目录 npz 幸存
  assert.equal(
    (await app.request('http://x/files?root=training&path=ds/keep.txt')).status,
    200,
  )
  assert.equal(
    (await app.request('http://x/files?root=training&path=ds/sub/c.npz')).status,
    200,
  )

  // 目录不带 glob → 拒绝
  const bare = await app.request('http://x/files?root=training&path=ds', { method: 'DELETE' })
  assert.equal(bare.status, 400)

  // 单文件删除
  const one = await app.request('http://x/files?root=training&path=ds/keep.txt', {
    method: 'DELETE',
  })
  assert.equal(one.status, 200)
  assert.equal(
    (await app.request('http://x/files?root=training&path=ds/keep.txt')).status,
    404,
  )

  // 路径穿越拒绝
  const evil = await app.request('http://x/files?root=training&path=../x.txt', {
    method: 'DELETE',
  })
  assert.equal(evil.status, 400)
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

test('GET /list: 平层、glob、递归、totalBytes、目录条目', async () => {
  for (const p of ['ds/a.png', 'ds/b.png', 'ds/c.txt', 'ds/sub/d.png']) {
    await app.request(`http://x/upload?root=training&path=${encodeURIComponent(p)}`, {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
    })
  }

  const all = (await (
    await app.request('http://x/list?root=training&path=ds')
  ).json()) as {
    entries: { name: string; isDir: boolean }[]
    count: number
    dirs: number
    totalBytes: number
    truncated: boolean
  }
  assert.equal(all.count, 3) // a.png b.png c.txt
  assert.equal(all.dirs, 1) // sub
  assert.equal(all.totalBytes, 9)
  assert.equal(all.truncated, false)

  const png = (await (
    await app.request('http://x/list?root=training&path=ds&glob=*.png')
  ).json()) as { count: number; entries: { name: string }[] }
  assert.equal(png.count, 2)
  // 非递归 + glob：子目录也该被 glob 过滤掉
  assert.equal(png.entries.filter((e) => e.name === 'sub').length, 0)

  const recursive = (await (
    await app.request('http://x/list?root=training&path=ds&glob=*.png&recursive=1')
  ).json()) as { count: number; entries: { name: string }[] }
  assert.equal(recursive.count, 3)
  assert.ok(recursive.entries.some((e) => e.name === 'sub/d.png'))

  // path 省略 → 列 root 顶层
  const top = (await (
    await app.request('http://x/list?root=training')
  ).json()) as { count: number; dirs: number; path: string }
  assert.equal(top.path, '')
  assert.equal(top.count, 0)
  assert.equal(top.dirs, 1)

  // 不存在 → 404；未知 root → 404
  assert.equal((await app.request('http://x/list?root=training&path=nope')).status, 404)
  assert.equal((await app.request('http://x/list?root=nope&path=ds')).status, 404)
})

test('GET /files 指向目录时 400，不再返回 200 空 body', async () => {
  await app.request('http://x/upload?root=training&path=ds/a.png', {
    method: 'POST',
    body: new Uint8Array([1]),
  })
  const res = await app.request('http://x/files?root=training&path=ds')
  assert.equal(res.status, 400)
  const json = (await res.json()) as { error: string }
  assert.match(json.error, /directory; use GET \/list/)
})

test('POST /sync 对账：删多余、报缺失、prune=false 只读', async () => {
  for (const p of ['ds/a.png', 'ds/a.txt', 'ds/stale.png']) {
    await app.request(`http://x/upload?root=training&path=${encodeURIComponent(p)}`, {
      method: 'POST',
      body: new Uint8Array([1]),
    })
  }

  const res = await app.request('http://x/sync?root=training&path=ds', {
    method: 'POST',
    body: JSON.stringify({ files: ['a.png', 'a.txt', 'b.png'] }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(res.status, 200)
  const json = (await res.json()) as {
    kept: string[]
    deleted: string[]
    missing: string[]
    count: number
  }
  assert.deepEqual(json.deleted, ['stale.png'])
  assert.deepEqual(json.missing, ['b.png'])
  assert.deepEqual(json.kept.sort(), ['a.png', 'a.txt'])
  assert.equal(json.count, 2)
  assert.equal(
    (await app.request('http://x/files?root=training&path=ds/stale.png')).status,
    404,
  )

  // prune=false：只对账不删
  const dry = await app.request('http://x/sync?root=training&path=ds', {
    method: 'POST',
    body: JSON.stringify({ files: ['a.png'], prune: false }),
    headers: { 'content-type': 'application/json' },
  })
  const dryJson = (await dry.json()) as { deleted: string[]; count: number }
  assert.deepEqual(dryJson.deleted, [])
  assert.equal(
    (await app.request('http://x/files?root=training&path=ds/a.txt')).status,
    200,
  )

  // 带路径分隔符的名字一律拒绝（对账只作用于平层）
  const bad = await app.request('http://x/sync?root=training&path=ds', {
    method: 'POST',
    body: JSON.stringify({ files: ['../x.png'] }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(bad.status, 400)
})

test('GET /disk reports root usage once directories exist', async () => {
  await app.request('http://x/upload?root=training&path=ds/a.png', {
    method: 'POST',
    body: new Uint8Array([1]),
  })
  const res = await app.request('http://x/disk')
  assert.equal(res.status, 200)
  const json = (await res.json()) as {
    disks: { root: string; totalBytes: number; freeBytes: number }[]
    unavailable: boolean
  }
  assert.equal(json.unavailable, false)
  const training = json.disks.find((d) => d.root === 'training')
  assert.ok(training)
  assert.ok(training.totalBytes > 0)
  assert.ok(training.freeBytes >= 0)
})
