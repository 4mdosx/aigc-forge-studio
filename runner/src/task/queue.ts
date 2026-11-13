import type { DatabaseSync } from 'node:sqlite'

import {
  assertSuccess,
  type ComfyClient,
  type HistoryEntry,
} from '../comfy/client.ts'
import { taskById, type TaskRow } from '../db.ts'
import { RunnerError } from '../errors.ts'
import { completePrompt } from '../llm.ts'
import type { Prompt } from '../workflow/graph.ts'
import { preparedPrompt, resultPaths, taskAdapterJson } from './records.ts'

export interface Runner {
  db: DatabaseSync
  clients: ComfyClient[]
  llm: {
    baseURL: string
    model: string
    concurrency: number
    timeoutMs: number
  } | null
  timeoutMs: number
  now: () => Date
  randomSeed: () => number
  stops: Map<string, AbortController>
  fetchImpl?: typeof fetch
}

export function resume(runner: Runner): void {
  const now = runner.now().toISOString()
  runner.db
    .prepare(
      `UPDATE tasks
       SET status = 'failed', error = 'runner restarted', completed_at = ?
       WHERE executor = 'llm' AND status = 'running'`,
    )
    .run(now)
  runner.db
    .prepare(
      `UPDATE tasks
       SET status = 'pending', started_at = NULL, comfy_base_url = NULL
       WHERE executor = 'comfyui' AND status = 'running' AND prompt_id IS NULL`,
    )
    .run()
}

export async function tick(runner: Runner): Promise<void> {
  await settleComfy(runner)
  await claimComfy(runner)
  settleLlm(runner)
  claimLlm(runner)
}

async function settleComfy(runner: Runner): Promise<void> {
  const running = runner.db
    .prepare(
      `SELECT * FROM tasks WHERE executor = 'comfyui' AND status = 'running'`,
    )
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
      const paths = resultPaths(prompt, taskAdapterJson(runner.db, task), entry)
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
           WHERE executor = 'comfyui' AND status = 'running' AND comfy_base_url IS NOT NULL`,
        )
        .all() as unknown as Array<{ comfy_base_url: string }>
    ).map((row) => row.comfy_base_url),
  )
  const pending = runner.db
    .prepare(
      `SELECT * FROM tasks
       WHERE executor = 'comfyui' AND status = 'pending'
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

function settleLlm(runner: Runner): void {
  if (!runner.llm) return
  const running = runner.db
    .prepare(
      `SELECT * FROM tasks WHERE executor = 'llm' AND status = 'running'`,
    )
    .all() as unknown as TaskRow[]
  for (const task of running) {
    if (
      !task.started_at ||
      !expired(task.started_at, runner.llm.timeoutMs, runner.now())
    )
      continue
    runner.stops.get(task.id)?.abort()
    finish(runner, task.id, 'timeout', { error: 'timed out' })
  }
}

function claimLlm(runner: Runner): void {
  if (!runner.llm) return
  const active = (
    runner.db
      .prepare(
        `SELECT COUNT(*) AS count FROM tasks WHERE executor = 'llm' AND status = 'running'`,
      )
      .get() as { count: number }
  ).count
  const room = runner.llm.concurrency - active
  if (room <= 0) return
  const pending = runner.db
    .prepare(
      `SELECT * FROM tasks
       WHERE executor = 'llm' AND status = 'pending'
       ORDER BY created_at, rowid
       LIMIT ?`,
    )
    .all(room) as unknown as TaskRow[]
  for (const task of pending) {
    const started = runner.now().toISOString()
    const claimed = runner.db
      .prepare(
        `UPDATE tasks SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(started, task.id)
    if (claimed.changes !== 1) continue
    const stop = new AbortController()
    runner.stops.set(task.id, stop)
    const llm = runner.llm
    void runLlm(runner, task, llm, stop)
  }
}

async function runLlm(
  runner: Runner,
  task: TaskRow,
  llm: NonNullable<Runner['llm']>,
  stop: AbortController,
): Promise<void> {
  const timer = setTimeout(() => stop.abort(), llm.timeoutMs)
  try {
    const input = JSON.parse(task.input_json) as {
      prompt: string
      system?: string
    }
    const text = await completePrompt(
      llm.baseURL,
      llm.model,
      input,
      stop.signal,
      runner.fetchImpl,
    )
    const current = taskById(runner.db, task.id)
    if (current.status !== 'running') return
    finish(runner, task.id, 'completed', { outputText: text })
  } catch (err) {
    const current = taskById(runner.db, task.id)
    if (current.status !== 'running') return
    if (stop.signal.aborted)
      finish(runner, task.id, 'timeout', { error: 'timed out' })
    else finish(runner, task.id, 'failed', { error: messageOf(err) })
  } finally {
    clearTimeout(timer)
    runner.stops.delete(task.id)
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
    outputText?: string
  },
): void {
  runner.db
    .prepare(
      `UPDATE tasks
       SET status = ?, error = ?, output_path = COALESCE(?, output_path),
           process_json = COALESCE(?, process_json), output_text = COALESCE(?, output_text),
           completed_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(
      status,
      extra.error ?? null,
      extra.outputPath ?? null,
      extra.processJson ?? null,
      extra.outputText ?? null,
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

export function promptOf(
  task: TaskRow,
  db: DatabaseSync,
  randomSeed: () => number,
): Prompt {
  return preparedPrompt(db, task, randomSeed)
}
