import type { Hono } from 'hono'

import { type ComfyClient } from '../comfy/client.ts'
import { taskById } from '../db.ts'
import { RunnerError } from '../errors.ts'
import { relativePath, splitRelative, viewTarget } from '../path.ts'
import {
  fileItems,
  readStoredFile,
  selectStoredPath,
} from '../task/outputFiles.ts'
import type { Runner } from '../task/queue.ts'
import { bytesOf, editor, jsonObject, stringField } from './request.ts'

export function mountFiles(app: Hono, runner: Runner): void {
  // 清单：除了路径，还给出 index 定位的 url、类型、字节数、是否已缓存到本地。
  // 请求方不需要知道 output/<date>/<task>/ 这套命名，也不需要再拼一次路径。
  app.get('/tasks/:id/files', (c) => {
    const task = taskById(runner.db, c.req.param('id'))
    const files = fileItems(runner, task)
    return c.json({
      taskId: task.id,
      status: task.status,
      count: files.length,
      paths: files.map((item) => item.path),
      files,
    })
  })

  // 单文件：`/files/0`（序号）、`/files/<文件名>`、`/files/<完整 path>` 都认。
  // ?download=1 走 attachment；?refresh=1 跳过本地副本强制回源。
  app.get('/tasks/:id/files/*', async (c) => {
    const task = taskById(runner.db, c.req.param('id'))
    // 用原始 URL 而不是 c.req.path：后者已被规范化，`output/../x` 会提前塌成
    // `x`，路径穿越就成了「找不到文件」。这里先还原再交给 relativePath 判非法。
    const raw = c.req.raw.url
    const marker = `/tasks/${task.id}/files/`
    const at = raw.indexOf(marker)
    const rawSelector = (at >= 0 ? raw.slice(at + marker.length) : '').split(
      '?',
    )[0]
    const selector = relativePath(rawSelector ?? '')
    const path = selectStoredPath(task, selector)
    const file = await readStoredFile(runner, task, path, {
      refresh: c.req.query('refresh') !== undefined,
    })

    if (c.req.header('if-none-match') === file.etag) {
      return c.body(null, 304, { etag: file.etag })
    }

    const headers: Record<string, string> = {
      'content-type': file.contentType,
      'cache-control': 'private, max-age=0, must-revalidate',
      etag: file.etag,
      // cache=本地副本 / comfy=本次从推理机取的（同时已落盘）
      'x-runner-source': file.cached ? 'cache' : 'comfy',
    }
    if (c.req.query('download') !== undefined) {
      const name = (path.split('/').pop() ?? 'download').replace(/["\\]/g, '_')
      headers['content-disposition'] = `attachment; filename="${name}"`
    }
    return c.body(bytesOf(file.bytes), 200, headers)
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
    const kind = body.kind === undefined ? 'misc' : stringField(body, 'kind')
    if (!/^[a-z][a-z0-9_-]*$/i.test(kind)) {
      throw new RunnerError('kind must be a simple name (letters/digits/-/_)')
    }
    if (runner.clients.length === 0)
      throw new RunnerError('no ComfyUI instance')
    // input 按日期+类型维护：input/<yyyy-MM-dd>/<kind>/<filename>
    const date = runner.now().toISOString().slice(0, 10)
    const subfolder = `${date}/${kind}`
    const published: string[] = []
    const skipped: string[] = []
    for (const item of paths) {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new RunnerError('paths must be strings')
      }
      const target = viewTarget(item)
      if (target.type !== 'output') {
        throw new RunnerError(`only output files can be published: ${item}`)
      }
      const filename = target.filename.split('/').pop() ?? target.filename
      const file = await editor(runner).viewFile(
        target.type,
        target.subfolder,
        target.filename,
      )
      // 下发前嗅探：目标文件已在推理机 input 则跳过上传
      const stale: ComfyClient[] = []
      for (const client of runner.clients) {
        let exists = false
        try {
          await client.viewFile('input', subfolder, filename)
          exists = true
        } catch {
          exists = false
        }
        if (!exists) {
          await client.uploadBytes(file.bytes, filename, subfolder)
          stale.push(client)
        }
      }
      const path = `input/${subfolder}/${filename}`
      if (stale.length === 0) skipped.push(path)
      else published.push(path)
    }
    return c.json({ paths: published, skipped }, 201)
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
