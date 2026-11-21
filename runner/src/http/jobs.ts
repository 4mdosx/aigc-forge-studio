import type { DatabaseSync } from 'node:sqlite'

import type { Hono } from 'hono'

import { JOB_KIND } from '../db.ts'
import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'

export type AllJobKind = 'generate' | 'capture.process' | 'download' | 'nobg'
export type JobStatusGroup = 'all' | 'pending' | 'running' | 'done' | 'failed'

export const ALL_JOB_KINDS: AllJobKind[] = [
  JOB_KIND.generate,
  JOB_KIND.process,
  JOB_KIND.download,
  JOB_KIND.nobg,
]

export interface UnifiedJob {
  id: string
  kind: AllJobKind
  status: string
  label: string
  detail: string
  assetId: string | null
  imgUrl: string | null
  originalUrl: string | null
  outputPath: string | null
  workflowName: string | null
  workName: string | null
  step: string | null
  error: string | null
  result: string | null
  attempts: number
  maxAttempts: number
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  elapsedMs: number | null
}

export interface AllJobsPage {
  items: UnifiedJob[]
  total: number
  page: number
  size: number
  pages: number
  kind: AllJobKind | 'all'
  status: JobStatusGroup
  counts: Record<AllJobKind, number>
  statusCounts: Record<JobStatusGroup, number>
}

export interface AllJobsQuery {
  kind?: string
  status?: string
  page?: string
  size?: string
}

type JobRow = {
  id: string
  kind: AllJobKind
  status: string
  task: string | null
  label: string | null
  url: string | null
  asset_id: string | null
  img_url: string | null
  asset_img_url: string | null
  original_path: string | null
  output_path: string | null
  workflow_name: string | null
  work_name: string | null
  step: string | null
  error: string | null
  result: string | null
  attempts: number
  max_attempts: number
  created_at: number
  started_at: number | null
  finished_at: number | null
}

const DONE_STATUSES = ['done', 'completed', 'skipped']
const FAILED_STATUSES = ['failed', 'timeout', 'cancelled']

const STATUS_GROUPS: Record<Exclude<JobStatusGroup, 'all'>, string[]> = {
  pending: ['pending'],
  running: ['running'],
  done: DONE_STATUSES,
  failed: FAILED_STATUSES,
}

const JOB_SELECT = `
  SELECT jobs.*,
         works.name AS work_name,
         image_assets.img_url AS asset_img_url,
         image_assets.original_path
  FROM jobs
  LEFT JOIN works ON works.id = jobs.work_id
  LEFT JOIN image_assets ON image_assets.id = jobs.asset_id
`

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value === '') return fallback
  if (!/^\d+$/.test(value)) throw new RunnerError('分页参数必须是正整数', 400)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RunnerError('分页参数必须是正整数', 400)
  }
  return Math.min(parsed, max)
}

function parseQuery(query: AllJobsQuery): {
  kind: AllJobKind | 'all'
  status: JobStatusGroup
  page: number
  size: number
} {
  const kind = query.kind ?? 'all'
  if (kind !== 'all' && !ALL_JOB_KINDS.includes(kind as AllJobKind)) {
    throw new RunnerError(`未知的任务类型: ${kind}`, 400)
  }
  const status = query.status ?? 'all'
  if (!(status in STATUS_GROUPS) && status !== 'all') {
    throw new RunnerError(`未知的任务状态: ${status}`, 400)
  }
  return {
    kind: kind as AllJobKind | 'all',
    status: status as JobStatusGroup,
    page: positiveInt(query.page, 1, 100_000),
    size: positiveInt(query.size, 20, 200),
  }
}

function statusGroupOf(status: string): Exclude<JobStatusGroup, 'all'> {
  for (const [group, values] of Object.entries(STATUS_GROUPS)) {
    if (values.includes(status)) return group as Exclude<JobStatusGroup, 'all'>
  }
  return 'failed'
}

function fileUrl(storedPath: string): string {
  return `/capture/file/${storedPath.replace(/^capture\//, '')}`
}

function labelOf(row: JobRow): { label: string; detail: string } {
  switch (row.kind) {
    case JOB_KIND.generate:
      return {
        label: row.task || row.workflow_name || row.id,
        detail: [row.work_name, row.workflow_name].filter(Boolean).join(' / '),
      }
    case JOB_KIND.process:
      return { label: row.asset_id ?? row.id, detail: `预处理 · ${row.step ?? ''}` }
    case JOB_KIND.download:
      return { label: row.label || row.url || row.id, detail: row.img_url || '下载原图' }
    case JOB_KIND.nobg:
      return { label: row.asset_id ?? row.id, detail: row.label || '移除背景' }
    default:
      return { label: row.id, detail: '' }
  }
}

function unifyJob(row: JobRow, now: number): UnifiedJob {
  const { label, detail } = labelOf(row)
  const start = row.started_at
  const end = row.finished_at ?? (row.status === 'running' ? now : null)
  const elapsedMs = start !== null && end !== null ? Math.max(0, end - start) : null
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    label,
    detail,
    assetId: row.asset_id ?? null,
    imgUrl: row.img_url || row.asset_img_url || null,
    originalUrl: row.original_path ? fileUrl(row.original_path) : null,
    outputPath: row.output_path ?? null,
    workflowName: row.workflow_name ?? null,
    workName: row.work_name ?? null,
    step: row.step ?? null,
    error: row.error ?? null,
    result: row.result ?? null,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    elapsedMs,
  }
}

export function pageAllJobs(
  db: DatabaseSync,
  query: AllJobsQuery,
  now: number,
): AllJobsPage {
  const { kind, status, page, size } = parseQuery(query)
  const clauses: string[] = ['1 = 1']
  const args: Array<string | number> = []
  if (kind !== 'all') {
    clauses.push('jobs.kind = ?')
    args.push(kind)
  }
  if (status !== 'all') {
    const values = STATUS_GROUPS[status]
    clauses.push(`jobs.status IN (${values.map(() => '?').join(', ')})`)
    args.push(...values)
  }
  const where = clauses.join(' AND ')

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${where}`).get(...args) as {
      n: number
    }
  ).n

  const kindRows = db
    .prepare('SELECT kind, COUNT(*) AS n FROM jobs GROUP BY kind')
    .all() as Array<{ kind: AllJobKind; n: number }>
  const counts = Object.fromEntries(ALL_JOB_KINDS.map((value) => [value, 0])) as Record<
    AllJobKind,
    number
  >
  for (const row of kindRows) {
    if (row.kind in counts) counts[row.kind] = row.n
  }

  const statusRows = db
    .prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status')
    .all() as Array<{ status: string; n: number }>
  const statusCounts = {
    all: 0,
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
  } satisfies Record<JobStatusGroup, number>
  for (const row of statusRows) {
    const group = statusGroupOf(row.status)
    statusCounts[group] += row.n
    statusCounts.all += row.n
  }

  const rows = db
    .prepare(
      `${JOB_SELECT}
       WHERE ${where}
       ORDER BY CASE jobs.status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                jobs.created_at DESC, jobs.rowid DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...args, size, (page - 1) * size) as JobRow[]

  return {
    items: rows.map((row) => unifyJob(row, now)),
    total,
    page,
    size,
    pages: Math.ceil(total / size),
    kind,
    status,
    counts,
    statusCounts,
  }
}

export function mountJobs(app: Hono, runner: Runner): void {
  app.get('/jobs', (c) => {
    return c.json(
      pageAllJobs(
        runner.db,
        {
          kind: c.req.query('kind'),
          status: c.req.query('status'),
          page: c.req.query('page'),
          size: c.req.query('size'),
        },
        runner.now().getTime(),
      ),
    )
  })
}
