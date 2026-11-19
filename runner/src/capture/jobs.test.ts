import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '../db.ts'
import type { Runner } from '../task/queue.ts'
import { createApp } from '../http/app.ts'
import {
  drainCaptureJobs,
  enqueueCaptureJob,
  listCaptureJobs,
  resumeCaptureJobs,
  type CaptureStep,
} from './jobs.ts'

test('resume enqueues collected assets and leaves processed ones alone', () => {
  const { runner, db } = harness()
  insertAsset(db, 'collected-1', 'collected')
  insertAsset(db, 'processed-1', 'processed')
  resumeCaptureJobs(db, runner.now().getTime())
  const listed = listCaptureJobs(db)
  assert.equal(listed.counts.pending, 1)
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0]?.assetId, 'collected-1')
  assert.equal(listed.items[0]?.step, 'prepare')
  resumeCaptureJobs(db, runner.now().getTime())
  assert.equal(listCaptureJobs(db).counts.pending, 1)
})

test('enqueue waits out an open job and requeues a failed collected asset', () => {
  const { runner, db } = harness()
  insertAsset(db, 'asset-1', 'collected')
  const now = runner.now().getTime()
  enqueueCaptureJob(db, 'asset-1', now)
  const first = listCaptureJobs(db).items[0]
  assert.ok(first)
  enqueueCaptureJob(db, 'asset-1', now + 1000)
  assert.equal(listCaptureJobs(db).items[0]?.id, first.id)
  assert.equal(listCaptureJobs(db).items[0]?.attempts, 0)
  db.prepare(`UPDATE jobs SET status = 'failed', attempts = 5, error = 'boom' WHERE id = ?`).run(
    first.id,
  )
  enqueueCaptureJob(db, 'asset-1', now + 2000)
  const again = listCaptureJobs(db).items[0]
  assert.equal(again?.status, 'pending')
  assert.equal(again?.attempts, 0)
  assert.equal(again?.error, null)
  assert.equal(again?.step, 'prepare')
  db.prepare(`UPDATE image_assets SET status = 'processed' WHERE id = ?`).run('asset-1')
  db.prepare(`UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?`).run(now, first.id)
  enqueueCaptureJob(db, 'asset-1', now + 3000)
  assert.equal(listCaptureJobs(db).counts.done, 1)
  assert.equal(listCaptureJobs(db).counts.pending, 0)
})

test('drain advances steps, backs off, then finishes from the failed step', async () => {
  const { runner, db, advance } = harness()
  enqueueCaptureJob(db, 'asset-1', runner.now().getTime())
  const seen: CaptureStep[] = []
  await drainCaptureJobs(runner, async (_assetId, step) => {
    seen.push(step)
    if (step === 'prepare') return 'tag'
    if (step === 'tag') return 'embed'
    throw new Error('embed down')
  })
  assert.deepEqual(seen, ['prepare', 'tag', 'embed'])
  let job = listCaptureJobs(db).items[0]
  assert.equal(job?.status, 'pending')
  assert.equal(job?.step, 'embed')
  assert.equal(job?.attempts, 1)
  assert.equal(job?.error, 'embed down')
  assert.equal(job?.nextRunAt, runner.now().getTime() + 5000)

  await drainCaptureJobs(runner, async () => {
    throw new Error('should not run')
  })
  assert.equal(listCaptureJobs(db).items[0]?.attempts, 1)

  advance(5000)
  await drainCaptureJobs(runner, async (_assetId, step) => {
    seen.push(step)
    assert.equal(step, 'embed')
    return 'done'
  })
  const finished = listCaptureJobs(db).items.find((item) => item.assetId === 'asset-1')
  assert.equal(finished?.status, 'done')
  assert.equal(finished?.error, null)
  assert.deepEqual(seen, ['prepare', 'tag', 'embed', 'embed'])
})

test('drain marks the job failed after the attempt budget', async () => {
  const { runner, db, at } = harness()
  enqueueCaptureJob(db, 'asset-1', runner.now().getTime())
  for (let i = 0; i < 6; i += 1) {
    const current = listCaptureJobs(db).items[0]
    if (!current || current.status === 'failed') break
    at(current.nextRunAt)
    await drainCaptureJobs(runner, async () => {
      throw new Error('critic down')
    })
  }
  const job = listCaptureJobs(db).items[0]
  assert.equal(job?.status, 'failed')
  assert.equal(job?.attempts, 5)
  assert.equal(job?.error, 'critic down')
})

test('a running drain does not claim a second job', async () => {
  const { runner, db } = harness()
  enqueueCaptureJob(db, 'asset-1', runner.now().getTime())
  enqueueCaptureJob(db, 'asset-2', runner.now().getTime() - 1)
  let started = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = drainCaptureJobs(runner, async () => {
    started += 1
    await gate
    return 'done'
  })
  await waitFor(() => started === 1)
  await drainCaptureJobs(runner, async () => {
    started += 1
    return 'done'
  })
  assert.equal(started, 1)
  release()
  await first
  assert.equal(listCaptureJobs(db).counts.done, 1)
  assert.equal(listCaptureJobs(db).counts.pending, 1)
})

test('job routes list progress and retry only failed jobs', async () => {
  const { runner, db } = harness()
  insertAsset(db, 'asset-1', 'collected')
  const app = createApp(runner)
  const listed = await app.request('/capture/jobs')
  assert.equal(listed.status, 200)
  const body = (await listed.json()) as {
    counts: { pending: number }
    items: Array<{ id: string; assetId: string; status: string }>
  }
  assert.equal(body.counts.pending, 1)
  const id = body.items[0]?.id
  assert.equal(body.items[0]?.assetId, 'asset-1')

  const early = await app.request(`/capture/jobs/${id}/retry`, { method: 'POST' })
  assert.equal(early.status, 409)

  db.prepare(`UPDATE jobs SET status = 'failed', attempts = 5, error = 'boom' WHERE id = ?`).run(id)
  const retried = await app.request(`/capture/jobs/${id}/retry`, { method: 'POST' })
  assert.equal(retried.status, 200)
  const job = (await retried.json()) as { status: string; attempts: number; error: string | null }
  assert.equal(job.status, 'pending')
  assert.equal(job.attempts, 0)
  assert.equal(job.error, null)

  const missing = await app.request('/capture/jobs/missing/retry', { method: 'POST' })
  assert.equal(missing.status, 404)
})

function harness(): {
  runner: Runner
  db: Runner['db']
  at: (ms: number) => void
  advance: (ms: number) => void
} {
  let clock = Date.parse('2026-01-01T00:00:00.000Z')
  const db = openDatabase(':memory:')
  const runner: Runner = {
    db,
    clients: [],
    chat: null,
    trainerBaseURL: null,
    timeoutMs: 600_000,
    dataDir: '/tmp/aigc-runner-test-data',
    now: () => new Date(clock),
    randomSeed: () => 1,
  }
  return {
    runner,
    db,
    at(ms: number) {
      clock = ms
    },
    advance(ms: number) {
      clock += ms
    },
  }
}

function insertAsset(db: Runner['db'], id: string, status: string): void {
  const now = Date.parse('2026-01-01T00:00:00.000Z')
  db.prepare(
    `INSERT INTO image_assets (
      id, status, source_type, source_url, img_url,
      original_path, original_width, original_height, hash,
      tags_json, embedding_json, tags_model_version, embedding_model_version,
      reviewed_at, created_at, updated_at
    ) VALUES (?, ?, 'manual', '', 'https://example.test/a.png', ?, 8, 8, ?, '[]', '[]', '', '', 0, ?, ?)`,
  ).run(id, status, `capture/raw/${id}/original.png`, id, now, now)
}

async function waitFor(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting')
}
