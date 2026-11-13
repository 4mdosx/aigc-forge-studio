import type { Hono } from 'hono'

import { taskById, type TaskRow } from '../db.ts'
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

export function mountTasks(app: Hono, runner: Runner): void {
  app.get('/tasks', (c) => {
    const rows = runner.db
      .prepare(
        `SELECT * FROM tasks WHERE status IN ('pending', 'running') ORDER BY created_at, rowid`,
      )
      .all() as unknown as TaskRow[]
    return c.json({ tasks: rows.map((row) => taskJson(runner.db, row)) })
  })

  app.post('/tasks', async (c) => {
    const body = await jsonObject(c.req)
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
        ...(optionalVersion(body) === undefined
          ? {}
          : { version: optionalVersion(body) }),
        ...(body.payload === undefined
          ? {}
          : { payload: objectField(body, 'payload') }),
        ...(body.parentTaskId === undefined
          ? {}
          : { parentTaskId: stringField(body, 'parentTaskId') }),
      },
      runner.now(),
      runner.randomSeed,
    )
    return c.json(taskJson(runner.db, task), 201)
  })

  app.get('/tasks/:id', (c) =>
    c.json(taskJson(runner.db, taskById(runner.db, c.req.param('id')))),
  )

  app.post('/tasks/:id/cancel', async (c) => {
    const task = taskById(runner.db, c.req.param('id'))
    const now = runner.now().toISOString()
    if (task.status === 'pending') {
      const updated = runner.db
        .prepare(
          `UPDATE tasks SET status = 'cancelled', completed_at = ? WHERE id = ? AND status = 'pending'`,
        )
        .run(now, task.id)
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
        `UPDATE tasks SET status = 'cancelled', completed_at = ? WHERE id = ? AND status = 'running'`,
      )
      .run(now, task.id)
    return c.json(taskJson(runner.db, taskById(runner.db, task.id)))
  })
}
