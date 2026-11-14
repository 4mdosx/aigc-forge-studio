import type { Hono } from 'hono'

import { taskById } from '../db.ts'
import { RunnerError } from '../errors.ts'
import { relativePath, splitRelative, viewTarget } from '../path.ts'
import { assertStoredPath, storedPaths } from '../task/records.ts'
import type { Runner } from '../task/queue.ts'
import { bytesOf, editor, jsonObject } from './request.ts'

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

  app.get('/files', async (c) => {
    const type = c.req.query('type')
    if (type !== 'input' && type !== 'output') {
      throw new RunnerError('type must be input or output')
    }
    const names = await editor(runner).listFiles(type)
    return c.json({
      files: names.map((name) => ({ name, path: `${type}/${name}` })),
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

  app.post('/files/publish', async (c) => {
    const body = await jsonObject(c.req)
    const paths = body.paths
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new RunnerError('paths must be a non-empty array')
    }
    if (paths.length > 16) throw new RunnerError('too many paths')
    if (runner.clients.length === 0)
      throw new RunnerError('no ComfyUI instance')
    const published: string[] = []
    for (const item of paths) {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new RunnerError('paths must be strings')
      }
      const target = viewTarget(item)
      if (target.type !== 'output') {
        throw new RunnerError(`only output files can be published: ${item}`)
      }
      const file = await editor(runner).viewFile(
        target.type,
        target.subfolder,
        target.filename,
      )
      for (const client of runner.clients) {
        await client.uploadBytes(file.bytes, target.filename, target.subfolder)
      }
      published.push(
        target.subfolder
          ? `input/${target.subfolder}/${target.filename}`
          : `input/${target.filename}`,
      )
    }
    return c.json({ paths: published }, 201)
  })

  app.get('/files/*', async (c) => {
    const path = relativePath(c.req.path.slice('/files/'.length))
    const head = path.split('/')[0]
    const target =
      head === 'input' || head === 'output' || head === 'temp'
        ? viewTarget(path)
        : { type: 'input', ...splitRelative(path) }
    const file = await editor(runner).viewFile(
      target.type,
      target.subfolder,
      target.filename,
    )
    return c.body(bytesOf(file.bytes), 200, {
      'content-type': file.contentType,
    })
  })
}
