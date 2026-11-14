import type { Context } from 'hono'

import type { DatabaseSync } from 'node:sqlite'

import type { ComfyClient } from '../comfy/client.ts'
import { isVersionId, type TaskRow } from '../db.ts'
import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'

export function editor(runner: Runner): ComfyClient {
  const client = runner.clients[0]
  if (!client) throw new RunnerError('no ComfyUI instance')
  return client
}

// 删除 work 后历史任务的 work_id 变悬空引用，回看时降级为 null
function workNameOf(db: DatabaseSync, workId: string | null): string | null {
  if (!workId) return null
  const row = db
    .prepare('SELECT name FROM works WHERE id = ?')
    .get(workId) as { name: string } | undefined
  return row?.name ?? null
}

export function taskJson(
  db: DatabaseSync,
  task: TaskRow,
): Record<string, unknown> {
  const version = task.head_revision_id
    ? (
        db
          .prepare('SELECT version FROM workflow_revisions WHERE id = ?')
          .get(task.head_revision_id) as { version: string } | undefined
      )?.version
    : undefined
  return {
    id: task.id,
    task: task.task,
    workId: task.work_id,
    workName: workNameOf(db, task.work_id),
    workflowId: task.workflow_id,
    workflowName: task.workflow_name,
    comfyPath: task.comfy_path,
    version: version ?? null,
    headRevisionId: task.head_revision_id,
    parentTaskId: task.parent_task_id,
    status: task.status,
    promptId: task.prompt_id,
    comfyBaseURL: task.comfy_base_url,
    error: task.error,
    outputPath: task.output_path,
    process: task.process_json
      ? (JSON.parse(task.process_json) as unknown)
      : null,
    createdAt: task.created_at,
    startedAt: task.started_at,
    completedAt: task.completed_at,
  }
}

export async function jsonObject(
  req: Context['req'],
): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw new RunnerError('invalid JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RunnerError('body must be a JSON object')
  }
  return body as Record<string, unknown>
}

export function stringField(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = body[key]
  if (typeof value !== 'string' || value === '')
    throw new RunnerError(`${key} is required`)
  return value
}

export function objectField(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = body[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RunnerError(`${key} must be an object`)
  }
  return value as Record<string, unknown>
}

export function optionalVersion(
  body: Record<string, unknown>,
): string | undefined {
  if (body.version === undefined) return undefined
  if (typeof body.version !== 'string' || !isVersionId(body.version)) {
    throw new RunnerError('version must be an 8 character id')
  }
  return body.version
}

export function bytesOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}
