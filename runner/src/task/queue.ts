import type { DatabaseSync } from 'node:sqlite'

import {
  assertSuccess,
  type ComfyClient,
  type HistoryEntry,
} from '../comfy/client.ts'
import type { ChatClient } from '../chat/client.ts'
import { taskById, type TaskRow } from '../db.ts'
import { RunnerError } from '../errors.ts'
import type { Prompt } from '../workflow/graph.ts'
import { expandPath, preparedPrompt, resultPaths, taskAdapterJson } from './records.ts'
import { findDegenerateOutputs } from './validate.ts'

export interface Runner {
  db: DatabaseSync
  clients: ComfyClient[]
  chat: ChatClient | null
  trainerBaseURL: string | null
  timeoutMs: number
  dataDir: string
  now: () => Date
  randomSeed: () => number
}

export function resume(runner: Runner): void {
  runner.db
    .prepare(
      `UPDATE tasks
       SET status = 'pending', started_at = NULL, comfy_base_url = NULL
       WHERE status = 'running' AND prompt_id IS NULL`,
    )
    .run()
}

export async function tick(runner: Runner): Promise<void> {
  await settleComfy(runner)
  await claimComfy(runner)
}

async function settleComfy(runner: Runner): Promise<void> {
  const running = runner.db
    .prepare(`SELECT * FROM tasks WHERE status = 'running'`)
    .all() as unknown as TaskRow[]
  for (const task of running) {
    if (!task.prompt_id || !task.comfy_base_url || !task.started_at) {
      runner.db
        .prepare(
          `UPDATE tasks
           SET status = 'pending', started_at = NULL, comfy_base_url = NULL, prompt_id = NULL
           WHERE id = ? AND status = 'running'`,
        )
        .run(task.id)
      continue
    }
    if (expired(task.started_at, runner.timeoutMs, runner.now())) {
      finish(runner, task.id, 'timeout', { error: 'timed out' })
      continue
    }
    const client = runner.clients.find(
      (item) => item.baseURL === task.comfy_base_url,
    )
    if (!client) continue
    let entry: HistoryEntry | null
    try {
      entry = await client.promptHistory(task.prompt_id)
    } catch {
      continue
    }
    if (!entry?.status?.completed && entry?.status?.status_str !== 'success') {
      if (entry?.status?.status_str === 'error') {
        finish(runner, task.id, 'failed', { error: errorOf(entry) })
      }
      continue
    }
    try {
      assertSuccess(entry)
      const prompt = preparedPrompt(runner.db, task, runner.randomSeed)
      const paths = resultPaths(prompt, taskAdapterJson(task), entry)
      const finalPaths = expandPath(paths.outputPath)
      const degenerate = await findDegenerateOutputs(client, finalPaths)
      if (degenerate.length > 0) {
        finish(runner, task.id, 'failed', {
          error: `output validation failed (degenerate image, e.g. empty skeleton): ${degenerate.join(', ')}`,
        })
        continue
      }
      finish(runner, task.id, 'completed', paths)
    } catch (err) {
      finish(runner, task.id, 'failed', { error: messageOf(err) })
    }
  }
}

async function claimComfy(runner: Runner): Promise<void> {
  const busy = new Set(
    (
      runner.db
        .prepare(
          `SELECT comfy_base_url FROM tasks
           WHERE status = 'running' AND comfy_base_url IS NOT NULL`,
        )
        .all() as unknown as Array<{ comfy_base_url: string }>
    ).map((row) => row.comfy_base_url),
  )
  const pending = runner.db
    .prepare(
      `SELECT * FROM tasks
       WHERE status = 'pending'
       ORDER BY created_at, rowid`,
    )
    .all() as unknown as TaskRow[]
  let index = 0
  for (const client of runner.clients) {
    if (busy.has(client.baseURL)) continue
    const task = pending[index]
    index += 1
    if (!task) return
    const started = runner.now().toISOString()
    const claimed = runner.db
      .prepare(
        `UPDATE tasks
         SET status = 'running', started_at = ?, comfy_base_url = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(started, client.baseURL, task.id)
    if (claimed.changes !== 1) continue
    try {
      const prompt = preparedPrompt(
        runner.db,
        taskById(runner.db, task.id),
        runner.randomSeed,
      )
      const promptId = await client.submitPrompt(prompt)
      runner.db
        .prepare(
          `UPDATE tasks SET prompt_id = ? WHERE id = ? AND status = 'running'`,
        )
        .run(promptId, task.id)
    } catch (err) {
      const retry =
        err instanceof RunnerError && err.message.startsWith('cannot reach')
      if (!retry && err instanceof RunnerError) {
        finish(runner, task.id, 'failed', { error: err.message })
      } else {
        runner.db
          .prepare(
            `UPDATE tasks
             SET status = 'pending', started_at = NULL, comfy_base_url = NULL, prompt_id = NULL
             WHERE id = ? AND status = 'running'`,
          )
          .run(task.id)
      }
    }
  }
}

function finish(
  runner: Runner,
  id: string,
  status: string,
  extra: {
    error?: string
    outputPath?: string
    processJson?: string
  },
): void {
  runner.db
    .prepare(
      `UPDATE tasks
       SET status = ?, error = ?, output_path = COALESCE(?, output_path),
           process_json = COALESCE(?, process_json), completed_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(
      status,
      extra.error ?? null,
      extra.outputPath ?? null,
      extra.processJson ?? null,
      runner.now().toISOString(),
      id,
    )
}

function expired(startedAt: string, timeoutMs: number, now: Date): boolean {
  return now.getTime() - Date.parse(startedAt) >= timeoutMs
}

function errorOf(entry: HistoryEntry): string {
  try {
    assertSuccess(entry)
    return 'execution error'
  } catch (err) {
    return messageOf(err)
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
