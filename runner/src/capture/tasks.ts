// 采集页前台队列的真相源：下载链接 + 移除背景。
// 浏览器只负责 POST 发起和 GET 查看；排队、状态、重试、重启恢复全在这里。
// 与 capture/jobs.ts 的分工：jobs 管入库后的预处理（prepare/tag/embed），这里管入库前和去背后。

import { randomInt } from 'node:crypto'
import { readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import {
  downloadTo,
  extOf,
  imageSignatureOf,
  normalizeMediaUrl,
  pixivRequestCookie,
  resolveMediaUrls,
} from '../http/capture.ts'
import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'
import { assetById, ingestBytes } from './asset.ts'
import type { LiveStatusState } from './live.ts'
import { removeBackground } from './nobg.ts'

export type CaptureTaskKind = 'download' | 'nobg'
export type CaptureTaskStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped'

export type CaptureTask = {
  id: string
  kind: CaptureTaskKind
  status: CaptureTaskStatus
  url: string
  imgUrl: string
  dedupeKey: string
  assetId: string | null
  liveId: string | null
  label: string
  attempts: number
  maxAttempts: number
  nextRunAt: number
  error: string | null
  result: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

type TaskRow = {
  id: string
  kind: string
  status: string
  url: string
  img_url: string
  dedupe_key: string
  asset_id: string | null
  live_id: string | null
  label: string
  attempts: number
  max_attempts: number
  next_run_at: number
  error: string | null
  result: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

type DownloadInput = {
  url: string
  mediaUrl?: string
  liveId?: string
}

const MAX_ATTEMPTS = 3
const LEASE_MS = 5 * 60 * 1000
const TASK_TIMEOUT_MS = 5 * 60 * 1000
const BACKOFF_MS = [5_000, 15_000, 45_000]
const KINDS: CaptureTaskKind[] = ['download', 'nobg']
const STATUSES: CaptureTaskStatus[] = [
  'pending',
  'running',
  'done',
  'failed',
  'skipped',
]

// 下载和移除背景各一条串行队列，跟浏览器时代的两条泵一致，互不阻塞。
const busy = new WeakMap<Runner, Set<CaptureTaskKind>>()

// 与前端 urlKey 同构：hash 去掉，host 小写；站点链接剥 query，pixiv 作品页收敛到作品 id。
// 图片直链保留路径（pixiv 多页不能合并）。
export function captureTaskKey(input: string): string {
  const text = input.trim()
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return text
  }
  url.hash = ''
  url.hostname = url.hostname.toLowerCase()
  const host = url.hostname
  const pixiv = /(^|\.)pixiv\.net$/.test(host)
  const pin =
    /(^|\.)pinterest\.[a-z.]+$/.test(host) ||
    host === 'pin.it' ||
    host.endsWith('.pin.it')
  const pximg = /(^|\.)pximg\.net$/.test(host)
  const pinimg = /(^|\.)pinimg\.com$/.test(host)
  if (pin || pixiv || pximg || pinimg) url.search = ''
  if (pixiv) {
    const artwork = /\/artworks\/(\d+)/.exec(url.pathname)
    if (artwork?.[1]) return `https://www.pixiv.net/artworks/${artwork[1]}`
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString()
}

function isSiteUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    return (
      /(^|\.)pinterest\.[a-z.]+$/.test(host) ||
      host === 'pin.it' ||
      host.endsWith('.pin.it') ||
      /(^|\.)pixiv\.net$/.test(host) ||
      /(^|\.)pximg\.net$/.test(host)
    )
  } catch {
    return false
  }
}

function knownKeys(db: DatabaseSync, exceptId?: string): Set<string> {
  const keys = new Set<string>()
  const assets = db
    .prepare('SELECT source_url, img_url FROM image_assets')
    .all() as Array<{ source_url: string; img_url: string }>
  for (const row of assets) {
    if (row.source_url) keys.add(captureTaskKey(row.source_url))
    if (row.img_url) keys.add(captureTaskKey(row.img_url))
  }
  const tasks = db
    .prepare(
      `SELECT id, dedupe_key, img_url FROM jobs
       WHERE kind IN ('download', 'nobg') AND status IN ('pending', 'running', 'done')`,
    )
    .all() as Array<{ id: string; dedupe_key: string; img_url: string }>
  for (const row of tasks) {
    if (row.id === exceptId) continue
    keys.add(row.dedupe_key)
    if (row.img_url) keys.add(captureTaskKey(row.img_url))
  }
  return keys
}

function duplicateOf(key: string, known: Set<string>): boolean {
  if (known.has(key)) return true
  const signature = imageSignatureOf(key)
  if (!signature) return false
  for (const item of known) {
    if (imageSignatureOf(item) === signature) return true
  }
  return false
}

function taskId(now: number): string {
  const stamp = new Date(now)
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}` +
    `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}` +
    `-${randomInt(0, 0x10000).toString(16).padStart(4, '0')}`
  )
}

export function enqueueDownload(
  db: DatabaseSync,
  input: DownloadInput,
  now: number,
): { task: CaptureTask | null; duplicate: boolean } {
  const url = input.url.trim()
  if (url === '') throw new RunnerError('url is required', 400)
  const mediaUrl = input.mediaUrl?.trim() ?? ''
  const key = captureTaskKey(mediaUrl || url)
  const known = knownKeys(db)
  if (duplicateOf(key, known)) return { task: null, duplicate: true }
  const label = mediaUrl || url
  db.prepare(
    `INSERT INTO jobs (
      id, kind, status, url, img_url, dedupe_key, asset_id, live_id, label,
      next_run_at, created_at
    ) VALUES (?, 'download', 'pending', ?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    taskId(now),
    url,
    mediaUrl,
    key,
    input.liveId ?? null,
    label.slice(0, 2000),
    now,
    now,
  )
  return { task: taskById(db, lastId(db)), duplicate: false }
}

export function enqueueNobg(
  db: DatabaseSync,
  assetId: string,
  now: number,
): { task: CaptureTask | null; skipped: boolean } {
  const asset = assetById(db, assetId)
  if (!asset) throw new RunnerError('image not found', 404)
  if (!asset.processed) throw new RunnerError('没有处理后的图片', 409)
  if (asset.status === 'approved') throw new RunnerError('已通过的图片不再移除背景', 409)
  if (asset.nobg) return { task: null, skipped: true }
  const sameHash = asset.original.hash
    ? db
        .prepare('SELECT id, nobg_path FROM image_assets WHERE hash = ?')
        .all(asset.original.hash) as Array<{ id: string; nobg_path: string | null }>
    : []
  if (sameHash.some((row) => row.nobg_path)) return { task: null, skipped: true }
  const sameHashIds = new Set(sameHash.map((row) => row.id))
  const queued = db
    .prepare(
      `SELECT asset_id FROM jobs
       WHERE kind = 'nobg' AND status IN ('pending', 'running', 'done')`,
    )
    .all() as Array<{ asset_id: string | null }>
  if (
    queued.some(
      (row) => row.asset_id === assetId || (row.asset_id && sameHashIds.has(row.asset_id)),
    )
  ) {
    return { task: null, skipped: true }
  }
  const label = asset.source.sourceUrl || asset.source.imgUrl || assetId
  db.prepare(
    `INSERT INTO jobs (
      id, kind, status, url, img_url, dedupe_key, asset_id, live_id, label,
      next_run_at, created_at
    ) VALUES (?, 'nobg', 'pending', '', '', ?, ?, NULL, ?, ?, ?)`,
  ).run(taskId(now), `nobg:${assetId}`, assetId, label.slice(0, 2000), now, now)
  return { task: taskById(db, lastId(db)), skipped: false }
}

function lastId(db: DatabaseSync): string {
  const row = db
    .prepare(`SELECT id FROM jobs WHERE kind IN ('download', 'nobg') ORDER BY rowid DESC LIMIT 1`)
    .get() as { id: string } | undefined
  if (!row) throw new RunnerError('capture task insert failed', 500)
  return row.id
}

export function resumeCaptureTasks(db: DatabaseSync, now: number): void {
  db.prepare(
    `UPDATE jobs SET
      status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
      next_run_at = ?,
      started_at = NULL,
      finished_at = CASE WHEN attempts >= max_attempts THEN ? ELSE finished_at END,
      error = CASE WHEN error IS NULL OR error = '' THEN 'interrupted' ELSE error END
     WHERE kind IN ('download', 'nobg') AND status = 'running'`,
  ).run(now, now)
}

export function listCaptureTasks(db: DatabaseSync): {
  counts: Record<CaptureTaskKind, Record<CaptureTaskStatus, number>>
  items: CaptureTask[]
} {
  const counts = Object.fromEntries(
    KINDS.map((kind) => [kind, Object.fromEntries(STATUSES.map((status) => [status, 0]))]),
  ) as Record<CaptureTaskKind, Record<CaptureTaskStatus, number>>
  const grouped = db
    .prepare(`SELECT kind, status, COUNT(*) AS n FROM jobs
               WHERE kind IN ('download', 'nobg') GROUP BY kind, status`)
    .all() as Array<{ kind: string; status: string; n: number }>
  for (const row of grouped) {
    if (!(row.kind in counts) || !(row.status in counts.download)) continue
    counts[row.kind as CaptureTaskKind][row.status as CaptureTaskStatus] = row.n
  }
  const open = db
    .prepare(
      `SELECT * FROM jobs
       WHERE kind IN ('download', 'nobg') AND status IN ('pending', 'running', 'failed')
       ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                next_run_at, created_at`,
    )
    .all() as TaskRow[]
  const recent: TaskRow[] = []
  for (const kind of KINDS) {
    const rows = db
      .prepare(
        `SELECT * FROM jobs
         WHERE kind = ? AND status IN ('done', 'skipped')
         ORDER BY finished_at DESC LIMIT 20`,
      )
      .all(kind) as TaskRow[]
    recent.push(...rows)
  }
  return {
    counts,
    items: [...open, ...recent].map(taskOf),
  }
}

export function retryCaptureTask(
  db: DatabaseSync,
  id: string,
  now: number,
): CaptureTask {
  const current = taskById(db, id)
  if (!current) throw new RunnerError('task not found', 404)
  if (current.status !== 'failed') throw new RunnerError('只有失败的任务可以重试', 409)
  db.prepare(
    `UPDATE jobs SET
      status = 'pending', attempts = 0, error = NULL, next_run_at = ?,
      started_at = NULL, finished_at = NULL
     WHERE id = ? AND kind IN ('download', 'nobg') AND status = 'failed'`,
  ).run(now, id)
  const next = taskById(db, id)
  if (!next) throw new RunnerError('task not found', 404)
  return next
}

function statusToLive(status: CaptureTaskStatus): LiveStatusState | null {
  if (status === 'running') return 'active'
  if (status === 'done') return 'done'
  if (status === 'skipped') return 'duplicate'
  if (status === 'failed') return 'failed'
  return null
}

function report(runner: Runner, task: CaptureTask): void {
  if (!task.liveId) return
  const state = statusToLive(task.status)
  if (!state) return
  const prefix = task.kind === 'download' ? '下载' : '移除背景'
  const messages: Partial<Record<LiveStatusState, string>> = {
    active: `正在${prefix}`,
    done: task.kind === 'download' ? '已下载原图' : '背景已移除',
    duplicate: '重复图片，已跳过',
    failed: task.error ?? `${prefix}失败`,
  }
  runner.captureLive?.report(task.liveId, state, messages[state])
}

export async function drainCaptureTasks(
  runner: Runner,
  kind: CaptureTaskKind,
): Promise<void> {
  let running = busy.get(runner)
  if (!running) {
    running = new Set()
    busy.set(runner, running)
  }
  if (running.has(kind)) return
  running.add(kind)
  try {
    reclaimExpired(runner)
    const task = claimNext(runner, kind)
    if (!task) return
    report(runner, task)
    const signal = AbortSignal.timeout(TASK_TIMEOUT_MS)
    try {
      if (signal.aborted) throw new Error('capture task timed out')
      if (task.kind === 'download') {
        const result = await runDownload(runner, task)
        finish(runner, task.id, result === 'duplicate' ? 'skipped' : 'done', result)
      } else {
        if (!task.assetId) throw new Error('nobg task has no asset')
        await removeBackground(runner, task.assetId)
        finish(runner, task.id, 'done', 'done')
      }
    } catch (err) {
      settleFailure(runner, task.id, err instanceof Error ? err.message : String(err))
    }
  } finally {
    running.delete(kind)
  }
}

async function runDownload(
  runner: Runner,
  task: CaptureTask,
): Promise<'added' | 'duplicate'> {
  // 浏览器手动输入的图片直链不经解析；站点作品页才走 resolve（可能出多页）。
  const images =
    task.imgUrl || !isSiteUrl(task.url)
      ? [normalizeMediaUrl(task.imgUrl || task.url)]
      : await resolveMediaUrls(task.url)
  const first = images[0]
  if (!first) throw new RunnerError('没有解析出图片', 422)
  const now = runner.now().getTime()
  for (const extra of images.slice(1)) {
    const media = normalizeMediaUrl(extra)
    enqueueDownload(runner.db, { url: task.url, mediaUrl: media }, now)
  }
  const mediaUrl = normalizeMediaUrl(first)
  const sourceUrl = task.imgUrl || isSiteUrl(task.url) ? task.url : ''
  const sourceType = sourceUrl === '' ? 'manual' : 'crawler'
  if (duplicateOf(captureTaskKey(mediaUrl), knownKeys(runner.db, task.id))) {
    return 'duplicate'
  }
  const ext = extOf(mediaUrl)
  const tempDir = join(runner.dataDir, 'capture', 'temp')
  mkdirSync(tempDir, { recursive: true })
  const tempAbs = join(tempDir, `${taskId(now)}${ext}`)
  await downloadTo(
    mediaUrl,
    tempAbs,
    refererOf(mediaUrl),
    pixivRequestCookie(mediaUrl),
  )
  const bytes = readFileSync(tempAbs)
  rmSync(tempAbs, { force: true })
  const { duplicate } = await ingestBytes(runner, bytes, ext, {
    type: sourceType,
    sourceUrl,
    imgUrl: mediaUrl,
  })
  return duplicate ? 'duplicate' : 'added'
}

function refererOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return /(^|\.)pximg\.net$/.test(host)
      ? 'https://www.pixiv.net/'
      : 'https://www.pinterest.com/'
  } catch {
    return 'https://www.pinterest.com/'
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
       WHERE kind IN ('download', 'nobg')
         AND status = 'running' AND started_at IS NOT NULL AND started_at <= ?`,
    )
    .run(now, now, now - LEASE_MS)
}

function claimNext(runner: Runner, kind: CaptureTaskKind): CaptureTask | null {
  const now = runner.now().getTime()
  const row = runner.db
    .prepare(
      `SELECT id FROM jobs
       WHERE kind = ? AND status = 'pending' AND next_run_at <= ?
       ORDER BY next_run_at, created_at LIMIT 1`,
    )
    .get(kind, now) as { id: string } | undefined
  if (!row) return null
  const claimed = runner.db
    .prepare(
      `UPDATE jobs
       SET status = 'running', started_at = ?, attempts = attempts + 1, error = NULL
       WHERE id = ? AND kind = ? AND status = 'pending'`,
    )
    .run(now, row.id, kind)
  if (claimed.changes !== 1) return null
  return taskById(runner.db, row.id)
}

function finish(
  runner: Runner,
  id: string,
  status: 'done' | 'skipped',
  result: string,
): void {
  const now = runner.now().getTime()
  runner.db
    .prepare(
      `UPDATE jobs SET
        status = ?, result = ?, error = NULL, finished_at = ?, started_at = NULL
       WHERE id = ? AND kind IN ('download', 'nobg') AND status = 'running'`,
    )
    .run(status, result, now, id)
  const task = taskById(runner.db, id)
  if (task) report(runner, task)
}

function settleFailure(runner: Runner, id: string, message: string): void {
  const task = taskById(runner.db, id)
  if (!task || task.status !== 'running') return
  console.error(`[capture tasks] ${task.kind} ${task.id}: ${message}`)
  const now = runner.now().getTime()
  if (task.attempts >= task.maxAttempts) {
    runner.db
      .prepare(
        `UPDATE jobs SET
          status = 'failed', error = ?, finished_at = ?, started_at = NULL
         WHERE id = ? AND kind IN ('download', 'nobg') AND status = 'running'`,
      )
      .run(message, now, id)
  } else {
    const delay = BACKOFF_MS[Math.min(task.attempts - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[0]
    runner.db
      .prepare(
        `UPDATE jobs SET
          status = 'pending', error = ?, next_run_at = ?, started_at = NULL
         WHERE id = ? AND kind IN ('download', 'nobg') AND status = 'running'`,
      )
      .run(message, now + delay, id)
    return
  }
  const failed = taskById(runner.db, id)
  if (failed) report(runner, failed)
}

function taskById(db: DatabaseSync, id: string): CaptureTask | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
    | TaskRow
    | undefined
  return row ? taskOf(row) : null
}

function taskOf(row: TaskRow): CaptureTask {
  return {
    id: row.id,
    kind: row.kind as CaptureTaskKind,
    status: row.status as CaptureTaskStatus,
    url: row.url,
    imgUrl: row.img_url,
    dedupeKey: row.dedupe_key,
    assetId: row.asset_id,
    liveId: row.live_id,
    label: row.label,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextRunAt: row.next_run_at,
    error: row.error,
    result: row.result,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}
