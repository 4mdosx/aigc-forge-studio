// 产出图库：把项目生成图从 jobs 里列出来，带通过/拒绝审核状态。
// 图源 = 新链路（base/cn 两个 workflow）的 completed generate job，展开 output_path。
// 通过时把图从 ComfyUI 复制到本地 data/output/<原相对路径>，原件保留不动。
// 审核状态落在 output_assets 表（按 path 唯一），条目本身从 jobs 惰性派生，不落库全量。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

import type { ComfyClient } from '../comfy/client.ts'
import { taskById, type TaskRow } from '../db.ts'
import { RunnerError } from '../errors.ts'
import { viewTarget } from '../path.ts'
import { expandPath } from '../task/records.ts'
import type { Runner } from '../task/queue.ts'
import { generationFromPng, type ComfyPrompt, type GenerationInfo } from './metadata.ts'

export type OutputStatus = 'pending' | 'approved' | 'rejected'

export const OUTPUT_WORKFLOWS = ['base_ax4z_lora_cn_1', 'baseline_ax4z_lora_v1'] as const
export const OUTPUT_STATUSES: OutputStatus[] = ['pending', 'approved', 'rejected']

export interface OutputItem {
  id: string
  path: string
  fileName: string
  jobId: string
  workflowName: string
  task: string
  status: OutputStatus
  createdAt: number
  reviewedAt: number | null
  localPath: string | null
}

export interface OutputList {
  total: number
  offset: number
  size: number
  counts: Record<OutputStatus, number>
  workflows: string[]
  items: OutputItem[]
}

export interface OutputDetail {
  item: OutputItem
  recipe: { kind: string; input: Record<string, unknown> } | null
  jobInput: Record<string, unknown> | null
  generation: { prompt: ComfyPrompt | null; info: GenerationInfo }
  imageUrl: string
}

/** 稳定 id：路径的 sha256 前 16 位（URL 安全，path 里带 / 不能直接当 id）。 */
export function outputId(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16)
}

function statusOf(raw: unknown): OutputStatus {
  return raw === 'approved' || raw === 'rejected' ? raw : 'pending'
}

interface DerivedRow {
  jobId: string
  workflowName: string
  task: string
  createdAt: number
  path: string
}

// 当前生效的图源：新链路两个 workflow 的已完成任务。每个 output_path（可能是 JSON 数组）展开成一张。
function deriveRows(db: DatabaseSync): DerivedRow[] {
  const placeholders = OUTPUT_WORKFLOWS.map(() => '?').join(',')
  const jobs = db
    .prepare(
      `SELECT id, workflow_name, task, output_path, created_at FROM jobs
       WHERE kind = 'generate' AND status IN ('completed', 'done')
         AND workflow_name IN (${placeholders})
         AND output_path IS NOT NULL AND output_path != ''
       ORDER BY created_at DESC`,
    )
    .all(...OUTPUT_WORKFLOWS) as Array<{
    id: string
    workflow_name: string | null
    task: string | null
    output_path: string
    created_at: number
  }>
  const rows: DerivedRow[] = []
  for (const job of jobs) {
    for (const path of expandPath(job.output_path)) {
      if (!path.startsWith('output/')) continue
      rows.push({
        jobId: job.id,
        workflowName: job.workflow_name ?? '',
        task: job.task ?? '',
        createdAt: job.created_at,
        path,
      })
    }
  }
  return rows
}

function reviewMap(db: DatabaseSync): Map<string, { status: OutputStatus; reviewedAt: number | null; localPath: string | null }> {
  const map = new Map<string, { status: OutputStatus; reviewedAt: number | null; localPath: string | null }>()
  for (const row of db
    .prepare('SELECT path, status, reviewed_at, local_path FROM output_assets')
    .all() as Array<{ path: string; status: string; reviewed_at: number | null; local_path: string | null }>) {
    map.set(row.path, {
      status: statusOf(row.status),
      reviewedAt: row.reviewed_at,
      localPath: row.local_path,
    })
  }
  return map
}

function toItem(row: DerivedRow, review: { status: OutputStatus; reviewedAt: number | null; localPath: string | null } | undefined): OutputItem {
  return {
    id: outputId(row.path),
    path: row.path,
    fileName: row.path.split('/').pop() ?? row.path,
    jobId: row.jobId,
    workflowName: row.workflowName,
    task: row.task,
    status: review?.status ?? 'pending',
    createdAt: row.createdAt,
    reviewedAt: review?.reviewedAt ?? null,
    localPath: review?.localPath ?? null,
  }
}

export function listOutputAssets(
  db: DatabaseSync,
  query: { status?: string; offset: number; size: number },
): OutputList {
  const status = query.status && query.status !== 'all' ? statusOf(query.status) : null
  const reviews = reviewMap(db)
  const all = deriveRows(db).map((row) => toItem(row, reviews.get(row.path)))
  const counts: Record<OutputStatus, number> = { pending: 0, approved: 0, rejected: 0 }
  for (const item of all) counts[item.status] += 1
  const filtered = status ? all.filter((item) => item.status === status) : all
  return {
    total: filtered.length,
    offset: query.offset,
    size: query.size,
    counts,
    workflows: [...OUTPUT_WORKFLOWS],
    items: filtered.slice(query.offset, query.offset + query.size),
  }
}

/** 通过 id 反查条目（扫描派生行，量很小）。 */
function findItem(db: DatabaseSync, id: string): OutputItem {
  const reviews = reviewMap(db)
  const row = deriveRows(db).find((item) => outputId(item.path) === id)
  if (!row) throw new RunnerError('output asset not found', 404)
  return toItem(row, reviews.get(row.path))
}

function upsertReview(
  db: DatabaseSync,
  item: OutputItem,
  status: OutputStatus,
  localPath: string | null,
  now: number,
): void {
  db.prepare(
    `INSERT INTO output_assets (id, path, job_id, workflow_name, task, status, local_path, created_at, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       status = excluded.status, local_path = excluded.local_path, reviewed_at = excluded.reviewed_at`,
  ).run(
    item.id,
    item.path,
    item.jobId,
    item.workflowName,
    item.task,
    status,
    localPath,
    item.createdAt,
    now,
  )
}

function clientFor(runner: Runner, job: TaskRow): ComfyClient {
  const configured: ComfyClient | undefined = job.comfy_base_url
    ? runner.clients.find((item) => item.baseURL === job.comfy_base_url)
    : undefined
  const client = configured ?? runner.clients[0]
  if (!client) throw new RunnerError('no ComfyUI instance', 404)
  return client
}

async function fetchBytes(runner: Runner, item: OutputItem): Promise<{ bytes: Uint8Array; contentType: string }> {
  // 已通过的图优先读本地副本，原件（ComfyUI）被清掉也不影响回看
  if (item.localPath) {
    const abs = join(runner.dataDir, item.localPath)
    if (existsSync(abs)) {
      const buf = readFileSync(abs)
      return { bytes: new Uint8Array(buf), contentType: imageContentType(item.localPath) }
    }
  }
  const job = taskById(runner.db, item.jobId)
  const target = viewTarget(item.path)
  const client = clientFor(runner, job)
  const file = await client.viewFile(target.type, target.subfolder, target.filename)
  return { bytes: file.bytes, contentType: file.contentType }
}

function imageContentType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return 'application/octet-stream'
}

export async function outputImage(
  runner: Runner,
  id: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const item = findItem(runner.db, id)
  return fetchBytes(runner, item)
}

export async function outputDetail(runner: Runner, id: string): Promise<OutputDetail> {
  const item = findItem(runner.db, id)
  const recipeRow = runner.db
    .prepare('SELECT kind, input_json FROM recipes WHERE job_id = ?')
    .get(item.jobId) as { kind: string; input_json: string } | undefined
  const job = taskById(runner.db, item.jobId)
  let jobInput: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(job.input_json)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      jobInput = parsed as Record<string, unknown>
  } catch {
    jobInput = null
  }
  const { bytes } = await fetchBytes(runner, item)
  return {
    item,
    recipe: recipeRow
      ? { kind: recipeRow.kind, input: JSON.parse(recipeRow.input_json) as Record<string, unknown> }
      : null,
    jobInput,
    generation: generationFromPng(bytes),
    imageUrl: `/output/image/${encodeURIComponent(id)}`,
  }
}

/** 通过：从 ComfyUI 拉图复制到本地 data/output/<path>，DB 标记 approved。幂等。 */
export async function approveOutput(runner: Runner, id: string): Promise<OutputItem> {
  const item = findItem(runner.db, id)
  const dest = join(runner.dataDir, item.path)
  if (!existsSync(dest)) {
    const { bytes } = await fetchBytes(runner, item)
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, bytes)
  }
  const now = runner.now().getTime()
  upsertReview(runner.db, item, 'approved', item.path, now)
  return findItem(runner.db, id)
}

/** 拒绝：只改审核状态，不动文件（非破坏性）。 */
export function rejectOutput(runner: Runner, id: string): OutputItem {
  const item = findItem(runner.db, id)
  upsertReview(runner.db, item, 'rejected', item.localPath, runner.now().getTime())
  return findItem(runner.db, id)
}
