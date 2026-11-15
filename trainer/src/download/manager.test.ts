import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, test } from 'node:test'

import { openDatabase } from '../db.ts'
import {
  cancel,
  createOrAttach,
  retry,
  recover,
  listDownloads,
  type DownloadRow,
  type Trainer,
} from './manager.ts'
import { buildRoots } from '../roots.ts'
import { startFixture } from '../testutil.ts'

let trainer: Trainer
let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'trainer-dl-'))
  const db = openDatabase(join(tmp, 'test.sqlite'))
  trainer = {
    db,
    roots: buildRoots({ models: join(tmp, 'models') }),
    controllers: new Map(),
    runs: new Map(),
    now: () => new Date(),
  }
})

afterEach(async () => {
  for (const [, promise] of trainer.runs) await promise
  trainer.db.close()
})

async function waitUntil(
  id: string,
  status: string,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now()
  for (;;) {
    const row = trainer.db
      .prepare('SELECT status FROM downloads WHERE id = ?')
      .get(id) as { status: string } | undefined
    if (row?.status === status) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting ${status}, got ${row?.status ?? 'gone'}`)
    }
    await new Promise((ok) => setTimeout(ok, 25))
  }
}

function rowOf(id: string): DownloadRow {
  return trainer.db
    .prepare('SELECT * FROM downloads WHERE id = ?')
    .get(id) as unknown as DownloadRow
}

test('download completes and records sha256', async () => {
  const fixture = await startFixture(1024 * 512, { chunkSize: 8192 })
  try {
    const { row, outcome } = createOrAttach(trainer, {
      url: fixture.url,
      root: 'models',
      path: 'text_encoders/test.bin',
    })
    assert.equal(outcome, 'created')
    await trainer.runs.get(row.id)
    const final = rowOf(row.id)
    assert.equal(final.status, 'completed')
    assert.equal(final.bytes_done, fixture.buffer.length)
    assert.equal(final.sha256, fixture.sha256)
    const written = readFileSync(join(tmp, 'models', 'text_encoders', 'test.bin'))
    assert.ok(written.equals(fixture.buffer))
    assert.ok(!existsSync(join(tmp, 'models', 'text_encoders', 'test.bin.part')))
  } finally {
    await fixture.close()
  }
})

test('re-posting a completed download dedupes without re-downloading', async () => {
  const fixture = await startFixture(1024)
  try {
    const first = createOrAttach(trainer, {
      url: fixture.url,
      root: 'models',
      path: 'a.bin',
    })
    await trainer.runs.get(first.row.id)
    const second = createOrAttach(trainer, {
      url: fixture.url,
      root: 'models',
      path: 'a.bin',
    })
    assert.equal(second.outcome, 'deduped')
    assert.equal(second.row.id, first.row.id)
    assert.equal(second.row.status, 'completed')
  } finally {
    await fixture.close()
  }
})

test('cancel keeps .part and retry resumes from offset', async () => {
  const fixture = await startFixture(1024 * 1024, {
    dripMs: 30,
    chunkSize: 16 * 1024,
  })
  try {
    const { row } = createOrAttach(trainer, {
      url: fixture.url,
      root: 'models',
      path: 'big.bin',
    })
    await waitUntil(row.id, 'running')
    // 让它下载一会儿
    await new Promise((ok) => setTimeout(ok, 200))
    const cancelled = await cancel(trainer, row.id)
    assert.equal(cancelled.status, 'cancelled')
    const partPath = join(tmp, 'models', 'big.bin.part')
    assert.ok(existsSync(partPath), '.part should survive cancel')
    const partial = statSync(partPath).size
    assert.ok(partial > 0, 'should have downloaded some bytes before cancel')

    const resumed = retry(trainer, row.id)
    await trainer.runs.get(resumed.id)
    const final = rowOf(row.id)
    assert.equal(final.status, 'completed')
    assert.equal(final.resumed_from, partial)
    assert.equal(final.sha256, fixture.sha256)
    assert.ok(fixture.rangeRequests >= 1, 'resume should issue Range request')
    assert.ok(
      readFileSync(join(tmp, 'models', 'big.bin')).equals(fixture.buffer),
    )
  } finally {
    await fixture.close()
  }
})

test('re-posting a cancelled download resumes it', async () => {
  const fixture = await startFixture(1024 * 1024, {
    dripMs: 30,
    chunkSize: 16 * 1024,
  })
  try {
    const first = createOrAttach(trainer, {
      url: fixture.url,
      root: 'models',
      path: 'big2.bin',
    })
    await waitUntil(first.row.id, 'running')
    await new Promise((ok) => setTimeout(ok, 150))
    await cancel(trainer, first.row.id)
    const second = createOrAttach(trainer, {
      url: fixture.url,
      root: 'models',
      path: 'big2.bin',
    })
    assert.equal(second.outcome, 'resumed')
    assert.equal(second.row.id, first.row.id)
    await trainer.runs.get(second.row.id)
    assert.equal(rowOf(second.row.id).status, 'completed')
  } finally {
    await fixture.close()
  }
})

test('failed download records error and retry resumes after server heals', async () => {
  const fixture = await startFixture(4096, { fail: true })
  try {
    const { row } = createOrAttach(trainer, {
      url: fixture.url,
      root: 'models',
      path: 'heal.bin',
    })
    await trainer.runs.get(row.id)
    assert.equal(rowOf(row.id).status, 'failed')
    assert.ok((rowOf(row.id).error ?? '').includes('500'))

    fixture.fail = false
    const resumed = retry(trainer, row.id)
    await trainer.runs.get(resumed.id)
    const final = rowOf(row.id)
    assert.equal(final.status, 'completed')
    assert.equal(final.sha256, fixture.sha256)
  } finally {
    await fixture.close()
  }
})

test('server without Range support restarts from zero', async () => {
  const fixture = await startFixture(4096, { noRange: true })
  try {
    // 伪造一个已存在的 .part（模拟上次中断）
    mkdirSync(join(tmp, 'models'), { recursive: true })
    writeFileSync(join(tmp, 'models', 'norange.bin.part'), Buffer.alloc(1000))
    const { row } = createOrAttach(trainer, {
      url: fixture.url,
      root: 'models',
      path: 'norange.bin',
    })
    await trainer.runs.get(row.id)
    const final = rowOf(row.id)
    assert.equal(final.status, 'completed')
    assert.equal(final.resumed_from, null)
    assert.ok(
      readFileSync(join(tmp, 'models', 'norange.bin')).equals(fixture.buffer),
    )
  } finally {
    await fixture.close()
  }
})

test('rejects bad url, bad path, unknown root', () => {
  assert.throws(() =>
    createOrAttach(trainer, { url: 'ftp://x/y', root: 'models', path: 'a.bin' }),
  )
  assert.throws(() =>
    createOrAttach(trainer, { url: 'not-a-url', root: 'models', path: 'a.bin' }),
  )
  assert.throws(() =>
    createOrAttach(trainer, { url: 'http://x/y', root: 'models', path: '../a' }),
  )
  assert.throws(() =>
    createOrAttach(trainer, { url: 'http://x/y', root: 'nope', path: 'a.bin' }),
  )
})

test('recover resumes pending tasks after restart', async () => {
  // 手工插一条 pending 记录，模拟进程重启前的残留
  trainer.db
    .prepare(
      `INSERT INTO downloads (id, url, root, path, status, created_at)
       VALUES ('rec1', ?, 'models', 'recovered.bin', 'pending', ?)`,
    )
    .run('http://localhost/nothing', trainer.now().toISOString())
  // nothing 服务器 → 会失败，但 recover 本身把 pending 捡起来跑即可
  recover(trainer)
  await trainer.runs.get('rec1')
  const rows = listDownloads(trainer.db, 'failed')
  assert.ok(rows.some((r) => r.id === 'rec1'))
})
