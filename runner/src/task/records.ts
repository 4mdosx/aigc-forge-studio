import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import {
  filesFromHistory,
  type HistoryEntry,
  type RemoteFile,
} from '../comfy/client.ts'
import {
  branchOf,
  JOB_KIND,
  revisionById,
  taskById,
  workflowByName,
  type RevisionRow,
  type TaskRow,
} from '../db.ts'
import { RunnerError } from '../errors.ts'
import { comfyFilePath, viewTarget } from '../path.ts'
import {
  applyAdapter,
  matchNode,
  parseAdapter,
  type AdapterMap,
} from '../workflow/binding.ts'
import type { Prompt } from '../workflow/graph.ts'
import { applyCompose } from '../work/promptCompose.ts'
import {
  linkOf,
  readAdapterMap,
  resolveAdapter,
  workByName,
} from '../work/works.ts'

export interface TaskInput {
  task: string
  workName?: string
  workflowName?: string
  version?: string
  payload?: Record<string, unknown>
  parentTaskId?: string
}

// 一次运行需要的全部上下文：work 挂的 workflow、要跑的版本、该版本绑定的 adapter。
// 路由层要先看一眼 adapter 有哪些槽位（比如有没有 pose_image 才决定能不能收 pose），
// 和 createTask 共用同一段解析，避免「路由按一套规则判断、执行按另一套」。
export interface RunContext {
  work: { id: string; name: string }
  workflow: { id: string; name: string; comfy_path: string }
  revision: RevisionRow
  adapter: AdapterMap
  api: Prompt
}

export function runContext(
  db: DatabaseSync,
  workName: string,
  workflowName: string,
  version?: string,
): RunContext {
  const work = workByName(db, workName)
  const workflow = workflowByName(db, workflowName)
  const revision = revisionForRun(db, workflow.id, version)
  const link = linkOf(db, work.id, workflow.id)
  if (!link) throw new RunnerError('workflow is not in this work')
  const history = db
    .prepare(
      `SELECT version, created_at FROM workflow_revisions
       WHERE workflow_id = ? ORDER BY created_at`,
    )
    .all(workflow.id) as Array<{ version: string; created_at: string }>
  const resolved = resolveAdapter(
    readAdapterMap(link.adapter_json),
    revision.version,
    history,
  )
  if (!resolved.adapter)
    throw new RunnerError('workflow version has no adapter')
  return {
    work: { id: work.id, name: work.name },
    workflow: { id: workflow.id, name: workflow.name, comfy_path: workflow.comfy_path },
    revision,
    adapter: resolved.adapter,
    api: JSON.parse(revision.api_json) as Prompt,
  }
}

export function createTask(
  db: DatabaseSync,
  input: TaskInput,
  now: Date,
  randomSeed: () => number,
  dataDir?: string,
): TaskRow {
  const task = required(input.task, 'task')
  if (input.parentTaskId) taskById(db, input.parentTaskId)
  const { work, workflow, revision, adapter, api } = runContext(
    db,
    required(input.workName, 'workName'),
    required(input.workflowName, 'workflowName'),
    input.version,
  )
  const payload = { ...(input.payload ?? {}) }
  if (dataDir) {
    applyCompose(api, adapter, payload, dataDir)
  } else if (
    (payload.rawPositive !== undefined || payload.rawNegative !== undefined) &&
    adapter.prompt?.compose
  ) {
    throw new RunnerError('prompt.compose requires runner dataDir')
  }
  // 缺省值回填：没交的槽位取工作流里的当前值，调用方只交要改的那几个 key。
  // 与 /generate/* 的 buildPayload 同语义；seed 不回填，交给 randomSeed。
  for (const [key, binding] of Object.entries(adapter.inputs)) {
    if (payload[key] !== undefined || binding.input === undefined) continue
    // seed 交给 randomSeed；带 map 的槽位（step -> lora 文件名）现值是映射后的结果，
    // 回填后再过一遍 map 会炸，所以也不回填。
    if (binding.input === 'seed' || binding.map) continue
    const current = matchNode(api, binding).node.inputs[binding.input]
    if (current !== undefined) payload[key] = current
  }
  const applied = applyAdapter(api, adapter, payload, randomSeed)
  const id = randomUUID()
  db.prepare(
    `INSERT INTO jobs
      (id, kind, workflow_name, workflow_id, work_id, comfy_path, adapter_json, api_json,
       head_revision_id, parent_task_id, task, input_json, status, created_at, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0)`,
  ).run(
    id,
    JOB_KIND.generate,
    workflow.name,
    workflow.id,
    work.id,
    workflow.comfy_path,
    JSON.stringify(adapter),
    revision.api_json,
    revision.id,
    input.parentTaskId ?? null,
    task,
    JSON.stringify(applied.input),
    now.getTime(),
  )
  return taskById(db, id)
}

// 输出路径约定（2026-11-14 token 定）：SaveImage 一律落到
// <yyyy-MM-dd>/<task 名>/<workflow 原前缀>/ 下；img2pose 类工作流的
// 原前缀只剩类型名（skeleton/depth），最终形态即 /日期/任务id/类型。
const stampedSaveTypes = new Set(['SaveImage', 'SaveImageAdvanced'])

function outputDateDir(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown-date'
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function stampOutputPath(prompt: Prompt, task: TaskRow): Prompt {
  const dir = `${outputDateDir(task.created_at)}/${task.task}`
  for (const node of Object.values(prompt)) {
    if (!stampedSaveTypes.has(node.class_type)) continue
    const prefix = node.inputs.filename_prefix
    if (typeof prefix !== 'string' || prefix.startsWith('[')) continue
    node.inputs.filename_prefix = `${dir}/${prefix}`
  }
  return prompt
}

export function preparedPrompt(
  db: DatabaseSync,
  task: TaskRow,
  randomSeed: () => number,
): Prompt {
  const applied = applyAdapter(
    JSON.parse(taskGraph(db, task)) as Prompt,
    parseAdapter(JSON.parse(taskAdapterJson(task)) as unknown),
    JSON.parse(task.input_json) as Record<string, unknown>,
    randomSeed,
  )
  return stampOutputPath(applied.prompt, task)
}

export function taskAdapterJson(task: TaskRow): string {
  if (task.adapter_json) return task.adapter_json
  throw new RunnerError('task has no adapter')
}

function taskGraph(db: DatabaseSync, task: TaskRow): string {
  if (task.api_json) return task.api_json
  if (!task.head_revision_id) throw new RunnerError('task has no revision')
  return revisionById(db, task.head_revision_id).api_json
}

function revisionForRun(
  db: DatabaseSync,
  workflowId: string,
  version: string | undefined,
): RevisionRow {
  if (version === undefined) {
    return revisionById(db, branchOf(db, workflowId, 'main').head_revision_id)
  }
  const row = db
    .prepare(
      'SELECT * FROM workflow_revisions WHERE workflow_id = ? AND version = ?',
    )
    .get(workflowId, version) as RevisionRow | undefined
  if (!row) throw new RunnerError(`version ${version} not found`, 404)
  return row
}

export function resultPaths(
  prompt: Prompt,
  adapterJson: string,
  entry: HistoryEntry,
): {
  outputPath: string
  processJson: string
} {
  const adapter = parseAdapter(JSON.parse(adapterJson) as unknown)
  const finalIds = new Set(
    Object.values(adapter.outputs).map(
      (binding) => matchNode(prompt, binding).id,
    ),
  )
  const files = filesFromHistory(entry)
  const final = files.filter((file) => finalIds.has(file.nodeId)).map(filePath)
  const process = files
    .filter((file) => !finalIds.has(file.nodeId))
    .map((file) => ({
      path: filePath(file),
      name: prompt[file.nodeId]?._meta?.title ?? '',
      id: file.nodeId,
    }))
  return {
    outputPath: final.length === 1 ? (final[0] ?? '') : JSON.stringify(final),
    processJson: JSON.stringify(process),
  }
}

export function storedPaths(task: TaskRow): string[] {
  const paths: string[] = []
  if (task.output_path) paths.push(...expandPath(task.output_path))
  if (task.process_json) {
    const items = JSON.parse(task.process_json) as Array<{ path?: unknown }>
    for (const item of items) {
      if (typeof item.path === 'string') paths.push(item.path)
    }
  }
  return paths
}

export function assertStoredPath(task: TaskRow, path: string): void {
  viewTarget(path)
  if (!storedPaths(task).includes(path))
    throw new RunnerError('file is not part of this task', 404)
}

export function expandPath(value: string): string[] {
  if (value.startsWith('[')) {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  }
  return [value]
}

function filePath(file: RemoteFile): string {
  return comfyFilePath(file.type, file.subfolder, file.filename)
}

function required(value: string | undefined, key: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new RunnerError(`${key} is required`)
  return value.trim()
}
