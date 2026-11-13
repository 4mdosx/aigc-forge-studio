import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import {
  filesFromHistory,
  type HistoryEntry,
  type RemoteFile,
} from '../comfy/client.ts'
import {
  branchOf,
  revisionById,
  taskById,
  workflowByName,
  type TaskRow,
} from '../db.ts'
import { RunnerError } from '../errors.ts'
import { comfyFilePath, viewTarget } from '../path.ts'
import { applyAdapter, matchNode, parseAdapter } from '../workflow/binding.ts'
import type { Prompt } from '../workflow/graph.ts'

export interface TaskInput {
  executor: 'comfyui' | 'llm'
  task: string
  workflowName?: string
  payload?: Record<string, unknown>
  parentTaskId?: string
}

export function createTask(
  db: DatabaseSync,
  input: TaskInput,
  now: Date,
  randomSeed: () => number,
): TaskRow {
  const task = required(input.task, 'task')
  if (input.parentTaskId) taskById(db, input.parentTaskId)
  if (input.executor === 'llm') {
    const payload = input.payload ?? {}
    if (typeof payload.prompt !== 'string' || payload.prompt === '') {
      throw new RunnerError('prompt is required')
    }
    const id = randomUUID()
    db.prepare(
      `INSERT INTO tasks
        (id, executor, task, input_json, status, parent_task_id, created_at)
       VALUES (?, 'llm', ?, ?, 'pending', ?, ?)`,
    ).run(
      id,
      task,
      JSON.stringify(payload),
      input.parentTaskId ?? null,
      now.toISOString(),
    )
    return taskById(db, id)
  }
  if (input.executor !== 'comfyui')
    throw new RunnerError('executor must be comfyui or llm')
  const workflowName = required(input.workflowName, 'workflowName')
  const workflow = workflowByName(db, workflowName)
  const branch = branchOf(db, workflow.id, workflow.current_branch)
  const revision = revisionById(db, branch.head_revision_id)
  if (!revision.adapter_json) throw new RunnerError('revision has no adapter')
  const adapter = parseAdapter(JSON.parse(revision.adapter_json) as unknown)
  const api = JSON.parse(revision.api_json) as Prompt
  const applied = applyAdapter(api, adapter, input.payload ?? {}, randomSeed)
  const id = randomUUID()
  db.prepare(
    `INSERT INTO tasks
      (id, executor, workflow_name, head_revision_id, parent_task_id, task, input_json, status, created_at)
     VALUES (?, 'comfyui', ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    id,
    workflow.name,
    revision.id,
    input.parentTaskId ?? null,
    task,
    JSON.stringify(applied.input),
    now.toISOString(),
  )
  return taskById(db, id)
}

export function preparedPrompt(
  db: DatabaseSync,
  task: TaskRow,
  randomSeed: () => number,
): Prompt {
  if (!task.head_revision_id) throw new RunnerError('task has no revision')
  const revision = revisionById(db, task.head_revision_id)
  if (!revision.adapter_json) throw new RunnerError('revision has no adapter')
  const applied = applyAdapter(
    JSON.parse(revision.api_json) as Prompt,
    parseAdapter(JSON.parse(revision.adapter_json) as unknown),
    JSON.parse(task.input_json) as Record<string, unknown>,
    randomSeed,
  )
  return applied.prompt
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

function expandPath(value: string): string[] {
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
