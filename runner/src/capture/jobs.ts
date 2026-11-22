import { randomBytes } from 'node:crypto'

import type { DatabaseSync } from 'node:sqlite'

import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'

export const CAPTURE_JOB = 'capture.process'
const MAX_ATTEMPTS = 5
const LEASE_MS = 3 * 60 * 1000
const STEP_TIMEOUT_MS = 3 * 60 * 1000
const BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000]

export type CaptureStep = 'prepare' | 'tag' | 'embed'
export type JobStatus = 'pending' | 'running' | 'failed' | 'done'

export type CaptureJob = {
  id: string
  assetId: string
  status: JobStatus
  step: CaptureStep
  attempts: number
  maxAttempts: number
  nextRunAt: number
  error: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  assetStatus: string | null
  imgUrl: string
  originalUrl: string | null
}

type JobRow = {
  id: string
  kind: string
  asset_id: string
  status: string
  step: string
  attempts: number
  max_attempts: number
  next_run_at: number
  error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  asset_status: string | null
  img_url: string | null
  original_path: string | null
}

const busy = new WeakSet<Runner>()

export function enqueueCaptureJob(
  db: DatabaseSync,
  assetId: string,
  now: number,
): void {
  const asset = db
    .prepare('SELECT status FROM image_assets WHERE id = ?')
    .get(assetId) as { status: string } | undefined
  if (asset && asset.status !== 'collected') return
  const existing = db
    .prepare('SELECT status FROM jobs WHERE kind = ? AND asset_id = ?')
    .get(CAPTURE_JOB, assetId) as { status: string } | undefined
  if (!existing) {
    db.prepare(
      `INSERT INTO jobs (
        id, kind, asset_id, status, step, attempts, max_attempts, next_run_at, created_at
      ) VALUES (?, ?, ?, 'pending', 'prepare', 0, ?, ?, ?)`,
    ).run(jobId(new Date(now)), CAPTURE_JOB, assetId, MAX_ATTEMPTS, now, now)
    return
  }
  if (existing.status === 'pending' || existing.status === 'running') return
  db.prepare(
    `UPDATE jobs SET
      status = 'pending', attempts = 0, error = NULL, next_run_at = ?,
      started_at = NULL, finished_at = NULL
    WHERE kind = ? AND asset_id = ?`,
  ).run(now, CAPTURE_JOB, assetId)
}

/** 单独排一个 embed 步骤：给换过向量模型的老图补算，跟采集队列共用一张表。 */
export function enqueueEmbedJob(
  db: DatabaseSync,
  assetId: string,
  now: number,
): void {
  const existing = db
    .prepare('SELECT status FROM jobs WHERE kind = ? AND asset_id = ?')
    .get(CAPTURE_JOB, assetId) as { status: string } | undefined
  if (!existing) {
    db.prepare(
      `INSERT INTO jobs (
        id, kind, asset_id, status, step, attempts, max_attempts, next_run_at, created_at
      ) VALUES (?, ?, ?, 'pending', 'embed', 0, ?, ?, ?)`,
    ).run(jobId(new Date(now)), CAPTURE_JOB, assetId, MAX_ATTEMPTS, now, now)
    return
  }
  if (existing.status === 'pending' || existing.status === 'running') return
  db.prepare(
    `UPDATE jobs SET
      status = 'pending', step = 'embed', attempts = 0, error = NULL, next_run_at = ?,
      started_at = NULL, finished_at = NULL
    WHERE kind = ? AND asset_id = ?`,
  ).run(now, CAPTURE_JOB, assetId)
}

export function resumeCaptureJobs(db: DatabaseSync, now: number): void {
  db.prepare(
    `UPDATE jobs SET
      status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
      next_run_at = ?,
      started_at = NULL,
      finished_at = CASE WHEN attempts >= max_attempts THEN ? ELSE finished_at END,
      error = CASE WHEN error IS NULL OR error = '' THEN 'interrupted' ELSE error END
    WHERE kind = ? AND status = 'running'`,
  ).run(now, now, CAPTURE_JOB)
  const missing = db
    .prepare(
      `SELECT id FROM image_assets
       WHERE status = 'collected'
         AND id NOT IN (SELECT asset_id FROM jobs WHERE kind = ?)`,
    )
    .all(CAPTURE_JOB) as Array<{ id: string }>
  for (const row of missing) enqueueCaptureJob(db, row.id, now)
}

export function listCaptureJobs(db: DatabaseSync): {
  counts: Record<JobStatus, number>
  items: CaptureJob[]
} {
  const counts: Record<JobStatus, number> = {
    pending: 0,
    running: 0,
    failed: 0,
    done: 0,
  }
  const grouped = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM jobs WHERE kind = ? GROUP BY status`,
    )
    .all(CAPTURE_JOB) as Array<{ status: string; n: number }>
  for (const row of grouped) {
    if (row.status in counts) counts[row.status as JobStatus] = row.n
  }
  const open = db
    .prepare(
      `${jobSelect}
       WHERE jobs.kind = ? AND jobs.status != 'done'
       ORDER BY CASE jobs.status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                jobs.next_run_at, jobs.created_at`,
    )
    .all(CAPTURE_JOB) as JobRow[]
  const done = db
    .prepare(
      `${jobSelect}
       WHERE jobs.kind = ? AND jobs.status = 'done'
       ORDER BY jobs.finished_at DESC
       LIMIT 20`,
    )
    .all(CAPTURE_JOB) as JobRow[]
  return { counts, items: [...open, ...done].map(jobOf) }
}

export function retryCaptureJob(
  db: DatabaseSync,
  id: string,
  now: number,
): CaptureJob {
  const current = jobById(db, id)
  if (!current) throw new RunnerError('job not found', 404)
  if (current.status !== 'failed')
    throw new RunnerError('只有失败的任务可以重试', 409)
  db.prepare(
    `UPDATE jobs SET
      status = 'pending', attempts = 0, error = NULL, next_run_at = ?,
      started_at = NULL, finished_at = NULL
    WHERE id = ? AND status = 'failed'`,
  ).run(now, id)
  const next = jobById(db, id)
  if (!next) throw new RunnerError('job not found', 404)
  return next
}

/** 处理一个排队中的采集任务。返回 false 表示队列空了、这一轮没干活。 */
export async function drainCaptureJobs(
  runner: Runner,
  run: (
    assetId: string,
    step: CaptureStep,
    signal: AbortSignal,
  ) => Promise<CaptureStep | 'done'>,
): Promise<boolean> {
  if (busy.has(runner)) return false
  busy.add(runner)
  try {
    reclaimExpired(runner)
    const job = claimNext(runner)
    if (!job) return false
    const signal = AbortSignal.timeout(STEP_TIMEOUT_MS)
    try {
      await runClaimed(runner, job, run, signal)
      finishDone(runner, job.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      settleFailure(runner, job.id, message)
    }
    return true
  } finally {
    busy.delete(runner)
  }
}

async function runClaimed(
  runner: Runner,
  job: CaptureJob,
  run: (
    assetId: string,
    step: CaptureStep,
    signal: AbortSignal,
  ) => Promise<CaptureStep | 'done'>,
  signal: AbortSignal,
): Promise<void> {
  let step = job.step
  while (true) {
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('capture job timed out')
    }
    const next = await run(job.assetId, step, signal)
    if (next === 'done') return
    if (next !== 'prepare' && next !== 'tag' && next !== 'embed') {
      throw new Error(`unexpected step: ${String(next)}`)
    }
    if (next === step) throw new Error(`step did not advance: ${step}`)
    runner.db
      .prepare(`UPDATE jobs SET step = ? WHERE id = ? AND status = 'running'`)
      .run(next, job.id)
    step = next
  }
}

function reclaimExpired(runner: Runner): void {
  const now = runner.now().getTime()
  runner.db
    .prepare(
      `UPDATE jobs SET
        status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
        next_run_at = ?,
        started_at = NULL,
        finished_at = CASE WHEN attempts >= max_attempts THEN ? ELSE finished_at END,
        error = CASE WHEN error IS NULL OR error = '' THEN 'interrupted' ELSE error END
      WHERE kind = ? AND status = 'running' AND started_at IS NOT NULL AND started_at <= ?`,
    )
    .run(now, now, CAPTURE_JOB, now - LEASE_MS)
}

function claimNext(runner: Runner): CaptureJob | null {
  const now = runner.now().getTime()
  const row = runner.db
    .prepare(
      `SELECT id FROM jobs
       WHERE kind = ? AND status = 'pending' AND next_run_at <= ?
       ORDER BY next_run_at, created_at
       LIMIT 1`,
    )
    .get(CAPTURE_JOB, now) as { id: string } | undefined
  if (!row) return null
  const claimed = runner.db
    .prepare(
      `UPDATE jobs
       SET status = 'running', started_at = ?, attempts = attempts + 1, error = NULL
       WHERE id = ? AND status = 'pending'`,
    )
    .run(now, row.id)
  if (claimed.changes !== 1) return null
  return jobById(runner.db, row.id)
}

function finishDone(runner: Runner, id: string): void {
  runner.db
    .prepare(
      `UPDATE jobs
       SET status = 'done', error = NULL, finished_at = ?, started_at = NULL
       WHERE id = ? AND status = 'running'`,
    )
    .run(runner.now().getTime(), id)
}

function settleFailure(runner: Runner, id: string, message: string): void {
  const job = jobById(runner.db, id)
  if (!job || job.status !== 'running') return
  console.error(`[capture] ${job.assetId} ${job.step}: ${message}`)
  const now = runner.now().getTime()
  if (job.attempts >= job.maxAttempts) {
    runner.db
      .prepare(
        `UPDATE jobs
         SET status = 'failed', error = ?, finished_at = ?, started_at = NULL
         WHERE id = ? AND status = 'running'`,
      )
      .run(message, now, id)
    return
  }
  const delay =
    BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)] ??
    BACKOFF_MS[0]
  runner.db
    .prepare(
      `UPDATE jobs
       SET status = 'pending', error = ?, next_run_at = ?, started_at = NULL
       WHERE id = ? AND status = 'running'`,
    )
    .run(message, now + delay, id)
}

function jobById(db: DatabaseSync, id: string): CaptureJob | null {
  const row = db.prepare(`${jobSelect} WHERE jobs.id = ?`).get(id) as
    JobRow | undefined
  return row ? jobOf(row) : null
}

const jobSelect = `
  SELECT jobs.*,
         image_assets.status AS asset_status,
         image_assets.img_url,
         image_assets.original_path
  FROM jobs
  LEFT JOIN image_assets ON image_assets.id = jobs.asset_id
`

function jobOf(row: JobRow): CaptureJob {
  const job: CaptureJob = {
    id: row.id,
    assetId: row.asset_id,
    status: row.status as JobStatus,
    step: row.step as CaptureStep,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextRunAt: row.next_run_at,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    assetStatus: row.asset_status,
    imgUrl: row.img_url ?? '',
    originalUrl: row.original_path ? fileUrl(row.original_path) : null,
  }
  return job
}

function fileUrl(storedPath: string): string {
  const rel = storedPath.replace(/^capture\//, '')
  return `/capture/file/${rel}`
}

function jobId(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${stamp}-${randomBytes(2).toString('hex')}`
}
