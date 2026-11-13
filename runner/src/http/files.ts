import type { Hono } from 'hono'

import { taskById } from '../db.ts'
import { RunnerError } from '../errors.ts'
import { relativePath, splitRelative, viewTarget } from '../path.ts'
import { assertStoredPath, storedPaths } from '../task/records.ts'
import type { Runner } from '../task/queue.ts'
import { bytesOf, editor } from './request.ts'

export function mountFiles(app: Hono, runner: Runner): void {
  app.get('/tasks/:id/files', (c) => {
    const task = taskById(runner.db, c.req.param('id'))
    return c.json({ files: storedPaths(task) })
  })

  app.get('/tasks/:id/files/*', async (c) => {
    const task = taskById(runner.db, c.req.param('id'))
    const path = relativePath(
      c.req.path.slice(`/tasks/${task.id}/files/`.length),
    )
    assertStoredPath(task, path)
    if (!task.comfy_base_url)
      throw new RunnerError('task has no ComfyUI instance', 404)
    const client = runner.clients.find(
      (item) => item.baseURL === task.comfy_base_url,
    )
    if (!client) throw new RunnerError('task instance is not configured', 404)
    const target = viewTarget(path)
    const file = await client.viewFile(
      target.type,
      target.subfolder,
      target.filename,
    )
    return c.body(bytesOf(file.bytes), 200, {
      'content-type': file.contentType,
    })
  })

  app.post('/files', async (c) => {
    const body = await c.req.parseBody()
    const path = relativePath(typeof body.path === 'string' ? body.path : '')
    const file = body.file
    if (!(file instanceof File)) throw new RunnerError('file is required')
    const { filename, subfolder } = splitRelative(path)
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (runner.clients.length === 0)
      throw new RunnerError('no ComfyUI instance')
    for (const client of runner.clients) {
      await client.uploadBytes(bytes, filename, subfolder)
    }
    return c.json({ path }, 201)
  })

  app.get('/files/*', async (c) => {
    const path = relativePath(c.req.path.slice('/files/'.length))
    const { filename, subfolder } = splitRelative(path)
    const file = await editor(runner).viewFile('input', subfolder, filename)
    return c.body(bytesOf(file.bytes), 200, {
      'content-type': file.contentType,
    })
  })
}
