import type { Context } from 'hono'

import type { ComfyClient } from '../comfy/client.ts'
import type { TaskRow } from '../db.ts'
import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'

export function editor(runner: Runner): ComfyClient {
  const client = runner.clients[0]
  if (!client) throw new RunnerError('no ComfyUI instance')
  return client
}

export function taskJson(task: TaskRow): Record<string, unknown> {
  return {
    id: task.id,
    executor: task.executor,
    task: task.task,
    workflowName: task.workflow_name,
    headRevisionId: task.head_revision_id,
    parentTaskId: task.parent_task_id,
    status: task.status,
    promptId: task.prompt_id,
    comfyBaseURL: task.comfy_base_url,
    error: task.error,
    outputText: task.output_text,
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

export function bytesOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}
