import type { Hono } from 'hono'

import { JOB_KIND, listTaskRows, taskById } from '../db.ts'
import { RunnerError } from '../errors.ts'
import { createTask } from '../task/records.ts'
import type { Runner } from '../task/queue.ts'
import {
  jsonObject,
  objectField,
  optionalVersion,
  stringField,
  taskJson,
} from './request.ts'
import { storedPaths } from '../task/records.ts'

export function mountTasks(app: Hono, runner: Runner): void {
  app.get('/tasks', (c) => {
    const rows = listTaskRows(
      runner.db,
      `status IN ('pending', 'running') ORDER BY created_at, rowid`,
    )
    return c.json({ tasks: rows.map((row) => taskJson(runner.db, row)) })
  })

  app.post('/tasks', async (c) => {
    const body = await jsonObject(c.req)
    const version = optionalVersion(body)
    const task = createTask(
      runner.db,
      {
        task: stringField(body, 'task'),
        ...(body.workName === undefined
          ? {}
          : { workName: stringField(body, 'workName') }),
        ...(body.workflowName === undefined
          ? {}
          : { workflowName: stringField(body, 'workflowName') }),
        ...(version === undefined ? {} : { version }),
        ...(body.payload === undefined
          ? {}
          : { payload: objectField(body, 'payload') }),
        ...(body.parentTaskId === undefined
          ? {}
          : { parentTaskId: stringField(body, 'parentTaskId') }),
      },
      runner.now(),
      runner.randomSeed,
      runner.dataDir,
    )
    return c.json(taskJson(runner.db, task), 201)
  })

  // 素材段溯源（2026-11-15 三段模型）：output 路径反查产图任务，
  // 带出当时的最终 payload（positive/negative 等）作为 repaint 素材段。
  app.get('/trace', (c) => {
    const path = c.req.query('path')
    if (!path) throw new RunnerError('path query is required')
    const rows = listTaskRows(
      runner.db,
      `output_path IS NOT NULL ORDER BY created_at DESC, rowid DESC`,
    )
    for (const row of rows) {
      const outputs = storedPaths(row).filter((p) => p.startsWith('output/'))
      if (!outputs.includes(path)) continue
      const workName =
        (runner.db
          .prepare(`SELECT name FROM works WHERE id = ?`)
          .get(row.work_id) as { name: string } | undefined)?.name ?? null
      return c.json({
        taskId: row.id,
        task: row.task,
        workName,
        workflowName: row.workflow_name,
        createdAt: row.created_at,
        payload: JSON.parse(row.input_json ?? '{}') as unknown,
      })
    }
    throw new RunnerError(`no task produced output ${path}`, 404)
  })

  app.get('/tasks/:id', (c) =>
    c.json(taskJson(runner.db, taskById(runner.db, c.req.param('id')))),
  )

  app.post('/tasks/:id/cancel', async (c) => {
    const task = taskById(runner.db, c.req.param('id'))
    const now = runner.now().getTime()
    if (task.status === 'pending') {
      const updated = runner.db
        .prepare(
          `UPDATE jobs SET status = 'cancelled', finished_at = ?
           WHERE id = ? AND kind = ? AND status = 'pending'`,
        )
        .run(now, task.id, JOB_KIND.generate)
      if (updated.changes !== 1)
        throw new RunnerError('task is no longer pending')
      return c.json(taskJson(runner.db, taskById(runner.db, task.id)))
    }
    if (task.status !== 'running') throw new RunnerError('task is not running')
    if (task.prompt_id && task.comfy_base_url) {
      const client = runner.clients.find(
        (item) => item.baseURL === task.comfy_base_url,
      )
      if (client) await client.cancelJob(task.prompt_id)
    }
    runner.db
      .prepare(
        `UPDATE jobs SET status = 'cancelled', finished_at = ?
         WHERE id = ? AND kind = ? AND status = 'running'`,
      )
      .run(now, task.id, JOB_KIND.generate)
    return c.json(taskJson(runner.db, taskById(runner.db, task.id)))
  })
}
