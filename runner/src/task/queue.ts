import type { DatabaseSync } from 'node:sqlite'

import { runCaptureStep } from '../capture/asset.ts'
import { drainCaptureJobs } from '../capture/jobs.ts'
import type { CaptureLive } from '../capture/live.ts'
import { drainCaptureTasks } from '../capture/tasks.ts'
import {
  assertSuccess,
  type ComfyClient,
  type HistoryEntry,
} from '../comfy/client.ts'
import type { ChatClient } from '../chat/client.ts'
import { JOB_KIND, listTaskRows, taskById, type TaskRow } from '../db.ts'
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
  captureLive?: CaptureLive
}

export function resume(runner: Runner): void {
  runner.db
    .prepare(
      `UPDATE jobs
       SET status = 'pending', started_at = NULL, comfy_base_url = NULL
       WHERE kind = ? AND status = 'running' AND prompt_id IS NULL`,
    )
    .run(JOB_KIND.generate)
}

export async function tick(runner: Runner): Promise<void> {
  await settleComfy(runner)
  await claimComfy(runner)
  await drainCaptureJobs(runner, (assetId, step, signal) =>
    runCaptureStep(runner, assetId, step, signal),
  )
  await drainCaptureTasks(runner, 'download')
  await drainCaptureTasks(runner, 'nobg')
}

async function settleComfy(runner: Runner): Promise<void> {
  const running = listTaskRows(runner.db, `status = 'running'`)
  for (const task of running) {
    if (!task.prompt_id || !task.comfy_base_url || !task.started_at) {
      runner.db
        .prepare(
          `UPDATE jobs
           SET status = 'pending', started_at = NULL, comfy_base_url = NULL, prompt_id = NULL
           WHERE id = ? AND kind = ? AND status = 'running'`,
        )
        .run(task.id, JOB_KIND.generate)
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
          `SELECT comfy_base_url FROM jobs
           WHERE kind = ? AND status = 'running' AND comfy_base_url IS NOT NULL`,
        )
        .all(JOB_KIND.generate) as unknown as Array<{ comfy_base_url: string }>
    ).map((row) => row.comfy_base_url),
  )
  const pending = listTaskRows(runner.db, `status = 'pending' ORDER BY created_at, rowid`)
  let index = 0
  for (const client of runner.clients) {
    if (busy.has(client.baseURL)) continue
    const task = pending[index]
    index += 1
    if (!task) return
    const started = runner.now().getTime()
    const claimed = runner.db
      .prepare(
        `UPDATE jobs
         SET status = 'running', started_at = ?, comfy_base_url = ?
         WHERE id = ? AND kind = ? AND status = 'pending'`,
      )
      .run(started, client.baseURL, task.id, JOB_KIND.generate)
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
          `UPDATE jobs SET prompt_id = ? WHERE id = ? AND kind = ? AND status = 'running'`,
        )
        .run(promptId, task.id, JOB_KIND.generate)
    } catch (err) {
      const retry =
        err instanceof RunnerError && err.message.startsWith('cannot reach')
      if (!retry && err instanceof RunnerError) {
        finish(runner, task.id, 'failed', { error: err.message })
      } else {
        runner.db
          .prepare(
            `UPDATE jobs
             SET status = 'pending', started_at = NULL, comfy_base_url = NULL, prompt_id = NULL
             WHERE id = ? AND kind = ? AND status = 'running'`,
          )
          .run(task.id, JOB_KIND.generate)
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
      `UPDATE jobs
       SET status = ?, error = ?, output_path = COALESCE(?, output_path),
           process_json = COALESCE(?, process_json), finished_at = ?
       WHERE id = ? AND kind = ? AND status = 'running'`,
    )
    .run(
      status,
      extra.error ?? null,
      extra.outputPath ?? null,
      extra.processJson ?? null,
      runner.now().getTime(),
      id,
      JOB_KIND.generate,
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
