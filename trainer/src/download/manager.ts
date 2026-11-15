import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, statSync } from 'node:fs'
import { mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { DatabaseSync } from 'node:sqlite'

import { TrainerError } from '../errors.ts'
import { relativePath } from '../path.ts'
import { resolveInRoot, type RootRegistry } from '../roots.ts'

const PART_SUFFIX = '.part'
const PROGRESS_FLUSH_MS = 1000
// 停滞超时：一次尝试内连续无数据多久算死连接
const STALL_TIMEOUT_MS = 30_000
// 停滞判定按速率算：窗口内字节增量低于「最低速率 × 窗口」视为死连接（涓涓细流也算）
const STALL_MIN_RATE_BPS = 32 * 1024
// 但速率阈值有个下限，防止测试用短窗口时阈值趋零误伤
const STALL_MIN_FLOOR = 64 * 1024
// 自动重试上限（含首次）；超过则落 failed
const MAX_ATTEMPTS = 20
// 重试间隔
const RETRY_DELAY_MS = 3_000

export interface RetryOptions {
  stallTimeoutMs?: number
  maxAttempts?: number
  retryDelayMs?: number
}

export type DownloadStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface DownloadRow {
  id: string
  url: string
  root: string
  path: string
  status: DownloadStatus
  bytes_done: number
  bytes_total: number | null
  resumed_from: number | null
  sha256: string | null
  error: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface Trainer {
  db: DatabaseSync
  /** config 写死的根目录注册表 */
  roots: RootRegistry
  /** 运行中的下载：id → AbortController */
  controllers: Map<string, AbortController>
  /** 运行中的下载：id → run promise，cancel 用它等状态落库 */
  runs: Map<string, Promise<void>>
  now: () => Date
  /** 重试参数覆盖（测试用；缺省用内置常量） */
  retry?: RetryOptions
}

export interface DownloadJson {
  id: string
  url: string
  root: string
  path: string
  status: DownloadStatus
  bytesDone: number
  bytesTotal: number | null
  resumedFrom: number | null
  sha256: string | null
  error: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export function downloadJson(row: DownloadRow): DownloadJson {
  return {
    id: row.id,
    url: row.url,
    root: row.root,
    path: row.path,
    status: row.status,
    bytesDone: row.bytes_done,
    bytesTotal: row.bytes_total,
    resumedFrom: row.resumed_from,
    sha256: row.sha256,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

function rowOf(db: DatabaseSync, id: string): DownloadRow | undefined {
  return db
    .prepare('SELECT * FROM downloads WHERE id = ?')
    .get(id) as DownloadRow | undefined
}

function rowByKey(
  db: DatabaseSync,
  url: string,
  root: string,
  path: string,
): DownloadRow | undefined {
  return db
    .prepare('SELECT * FROM downloads WHERE url = ? AND root = ? AND path = ?')
    .get(url, root, path) as DownloadRow | undefined
}

// 幂等的 create-or-attach：同一 (url, root, path) 三元组只对应一个任务。
//   completed → 原样返回（不重下）
//   pending/running → 原样返回
//   failed/cancelled → 就地复活并从 .part 断点续传
export function createOrAttach(
  trainer: Trainer,
  input: { url: string; root: string; path: string },
): { row: DownloadRow; outcome: 'created' | 'deduped' | 'resumed' } {
  const url = normalizeUrl(input.url)
  const path = relativePath(input.path)
  // root 校验前置：未知 root 立刻 404，不留一个注定失败的异步任务
  resolveInRoot(trainer.roots, input.root, path.split('/'))
  const existing = rowByKey(trainer.db, url, input.root, path)
  if (existing) {
    if (existing.status === 'failed' || existing.status === 'cancelled') {
      revive(trainer, existing.id)
      const row = rowOf(trainer.db, existing.id)
      if (!row) throw new TrainerError('download vanished', 500)
      return { row, outcome: 'resumed' }
    }
    return { row: existing, outcome: 'deduped' }
  }
  const id = randomUUID()
  trainer.db
    .prepare(
      `INSERT INTO downloads (id, url, root, path, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    )
    .run(id, url, input.root, path, trainer.now().toISOString())
  const run = start(trainer, id, false)
  trainer.runs.set(id, run)
  const row = rowOf(trainer.db, id)
  if (!row) throw new TrainerError('download vanished', 500)
  return { row, outcome: 'created' }
}

// 显式重试：只接受 failed/cancelled
export function retry(trainer: Trainer, id: string): DownloadRow {
  const row = rowOf(trainer.db, id)
  if (!row) throw new TrainerError('download not found', 404)
  if (row.status !== 'failed' && row.status !== 'cancelled') {
    throw new TrainerError(`cannot retry a ${row.status} download`, 409)
  }
  revive(trainer, id)
  const next = rowOf(trainer.db, id)
  if (!next) throw new TrainerError('download vanished', 500)
  return next
}

// 取消：running → abort 并等状态落库；pending → 直接 cancelled；终态 → 原样返回
export async function cancel(
  trainer: Trainer,
  id: string,
): Promise<DownloadRow> {
  const row = rowOf(trainer.db, id)
  if (!row) throw new TrainerError('download not found', 404)
  if (row.status === 'completed' || row.status === 'cancelled') return row
  const controller = trainer.controllers.get(id)
  if (controller) {
    controller.abort()
    await trainer.runs.get(id)
    const next = rowOf(trainer.db, id)
    if (!next) throw new TrainerError('download vanished', 500)
    return next
  }
  trainer.db
    .prepare(
      `UPDATE downloads
       SET status = 'cancelled', completed_at = ?, error = 'cancelled by request'
       WHERE id = ?`,
    )
    .run(trainer.now().toISOString(), id)
  const next = rowOf(trainer.db, id)
  if (!next) throw new TrainerError('download vanished', 500)
  return next
}

export function listDownloads(
  db: DatabaseSync,
  status?: string,
): DownloadRow[] {
  if (status) {
    return db
      .prepare('SELECT * FROM downloads WHERE status = ? ORDER BY created_at')
      .all(status) as unknown as DownloadRow[]
  }
  return db
    .prepare('SELECT * FROM downloads ORDER BY created_at')
    .all() as unknown as DownloadRow[]
}

function revive(trainer: Trainer, id: string): void {
  trainer.db
    .prepare(
      `UPDATE downloads
       SET status = 'pending', error = NULL, completed_at = NULL
       WHERE id = ?`,
    )
    .run(id)
  const run = start(trainer, id, true)
  trainer.runs.set(id, run)
}

function normalizeUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new TrainerError('url is not a valid URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TrainerError('url must be http(s)')
  }
  return url.toString()
}

// 启动恢复：进程崩溃留下的 running 标回 pending，pending 全部断点续传
export function recover(trainer: Trainer): void {
  trainer.db
    .prepare(
      `UPDATE downloads
       SET status = 'pending', error = 'recovered after restart'
       WHERE status = 'running'`,
    )
    .run()
  const rows = trainer.db
    .prepare("SELECT id FROM downloads WHERE status = 'pending'")
    .all() as { id: string }[]
  for (const row of rows) trainer.runs.set(row.id, start(trainer, row.id, true))
}

async function start(
  trainer: Trainer,
  id: string,
  resume: boolean,
): Promise<void> {
  try {
    await run(trainer, id, resume)
  } catch (err) {
    // run 内部已落库；这里只兜住意外异常防止 unhandled rejection
    const message = err instanceof Error ? err.message : String(err)
    trainer.db
      .prepare(
        `UPDATE downloads
         SET status = 'failed', error = ?, completed_at = ?
         WHERE id = ? AND status IN ('pending','running')`,
      )
      .run(message, trainer.now().toISOString(), id)
  } finally {
    trainer.runs.delete(id)
  }
}

// 单次尝试的终止信号：controller.abort('stall') 时 signal.reason === 'stall'
const STALL_REASON = 'stall'

// 下载执行外层：自动重试循环。
// 瞬时错误（网络中断、停滞超时）→ 断点续传重试；用户取消或穷尽重试才落终态。
async function run(
  trainer: Trainer,
  id: string,
  resume: boolean,
): Promise<void> {
  const opts = {
    stallTimeoutMs: trainer.retry?.stallTimeoutMs ?? STALL_TIMEOUT_MS,
    maxAttempts: trainer.retry?.maxAttempts ?? MAX_ATTEMPTS,
    retryDelayMs: trainer.retry?.retryDelayMs ?? RETRY_DELAY_MS,
  }
  for (let attempt = 1; ; attempt += 1) {
    // 重试间隔里可能被 cancel 直接写库，循环顶重新读状态
    const row = rowOf(trainer.db, id)
    if (!row) return
    if (row.status !== 'pending' && row.status !== 'running') return
    const target = resolveInRoot(trainer.roots, row.root, row.path.split('/'))
    const partPath = `${target}${PART_SUFFIX}`
    const controller = new AbortController()
    trainer.controllers.set(id, controller)
    try {
      await attemptOnce(
        trainer,
        id,
        controller,
        partPath,
        attempt > 1 || resume,
        opts.stallTimeoutMs,
      )
      return
    } catch (err) {
      const reason = controller.signal.reason
      const cancelledByUser =
        controller.signal.aborted && reason !== STALL_REASON
      const bytes = statSyncSafe(partPath) ?? 0
      if (cancelledByUser) {
        trainer.db
          .prepare(
            `UPDATE downloads
             SET status = 'cancelled', bytes_done = ?, error = 'cancelled by request', completed_at = ?
             WHERE id = ?`,
          )
          .run(bytes, trainer.now().toISOString(), id)
        return
      }
      const message =
        reason === STALL_REASON
          ? `stalled: no data for ${opts.stallTimeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err)
      if (attempt >= opts.maxAttempts) {
        trainer.db
          .prepare(
            `UPDATE downloads
             SET status = 'failed', bytes_done = ?, error = ?, completed_at = ?
             WHERE id = ?`,
          )
          .run(bytes, `${message} (after ${attempt} attempts)`, trainer.now().toISOString(), id)
        return
      }
      // 瞬时失败：记一笔，断点续传重试
      trainer.db
        .prepare(
          `UPDATE downloads
           SET bytes_done = ?, error = ?
           WHERE id = ?`,
        )
        .run(bytes, `attempt ${attempt} failed (${message}); retrying`, id)
      await sleep(opts.retryDelayMs)
    } finally {
      trainer.controllers.delete(id)
    }
  }
}

async function attemptOnce(
  trainer: Trainer,
  id: string,
  controller: AbortController,
  partPath: string,
  resume: boolean,
  stallTimeoutMs: number,
): Promise<void> {
  const row = rowOf(trainer.db, id)
  if (!row) return
  const target = partPath.slice(0, -PART_SUFFIX.length)
  await mkdir(join(partPath, '..'), { recursive: true })

  let offset = 0
  let done = 0
  if (resume) {
    try {
      offset = (await stat(partPath)).size
    } catch {
      offset = 0
    }
  }
  done = offset

  trainer.db
    .prepare(
      `UPDATE downloads
       SET status = 'running', started_at = ?, resumed_from = ?,
           bytes_done = ?, bytes_total = NULL, sha256 = NULL
       WHERE id = ?`,
    )
    .run(
      trainer.now().toISOString(),
      offset > 0 ? offset : null,
      offset,
      id,
    )

  // 停滞看护：周期性检查字节增量，增量不足（含完全停滞）就 abort 本次尝试。
  // 不能只看「有没有字节」——hf-mirror 会把死连接吊成涓涓细流骗过纯时间判定。
  const stallMinBytes = Math.max(
    STALL_MIN_FLOOR,
    Math.floor((STALL_MIN_RATE_BPS * stallTimeoutMs) / 1000),
  )
  let lastTickBytes = done
  const stallTimer = setInterval(() => {
    if (done - lastTickBytes < stallMinBytes) {
      controller.abort(STALL_REASON)
    }
    lastTickBytes = done
  }, stallTimeoutMs)

  try {
    const headers: Record<string, string> = {}
    if (offset > 0) headers.Range = `bytes=${offset}-`
    const response = await fetch(row.url, {
      headers,
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
    // 服务器不支持 Range（200 而非 206）时从头重来
    let append = offset > 0 && response.status === 206
    if (offset > 0 && response.status !== 206) {
      offset = 0
      done = 0
      append = false
      lastTickBytes = 0
      trainer.db
        .prepare('UPDATE downloads SET resumed_from = NULL WHERE id = ?')
        .run(id)
    }
    const contentLength = Number(response.headers.get('content-length'))
    const total = Number.isFinite(contentLength)
      ? offset + contentLength
      : null
    if (total !== null) {
      trainer.db
        .prepare('UPDATE downloads SET bytes_total = ? WHERE id = ?')
        .run(total, id)
    }

    let lastFlush = 0
    await pipeline(
      Readable.fromWeb(
        response.body as unknown as import('node:stream/web').ReadableStream,
      ),
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          done += chunk.length
          const now = Date.now()
          if (now - lastFlush > PROGRESS_FLUSH_MS) {
            trainer.db
              .prepare(
                'UPDATE downloads SET bytes_done = ?, bytes_total = ? WHERE id = ?',
              )
              .run(done, total, id)
            lastFlush = now
          }
          yield chunk
        }
      },
      createWriteStream(partPath, { flags: append ? 'a' : 'w' }),
    )
    clearInterval(stallTimer)

    if (total !== null && done !== total) {
      throw new Error(`size mismatch: got ${done}, expected ${total}`)
    }
    await rename(partPath, target)
    const sha256 = await hashFile(target)
    trainer.db
      .prepare(
        `UPDATE downloads
         SET status = 'completed', bytes_done = ?, bytes_total = ?,
             sha256 = ?, completed_at = ?, error = NULL
         WHERE id = ?`,
      )
      .run(done, total, sha256, trainer.now().toISOString(), id)
  } finally {
    clearInterval(stallTimer)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((ok) => setTimeout(ok, ms))
}

function statSyncSafe(path: string): number | null {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
