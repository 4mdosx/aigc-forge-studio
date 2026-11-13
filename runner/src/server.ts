import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { ComfyClient } from './comfy.ts'
import { findRepoRoot, loadConfig } from './config.ts'
import {
  openDatabase,
  revisionById,
  taskById,
  workflowByName,
  type TaskRow,
  type WorkflowRow,
} from './db.ts'
import { RunnerError } from './errors.ts'
import { relativePath, splitRelative, viewTarget } from './path.ts'
import { resume, tick, type Runner } from './queue.ts'
import {
  checkout,
  commitHead,
  createBranch,
  moveBranch,
  readAndCreate,
  switchBranch,
} from './revisions.ts'
import { assertStoredPath, createTask, storedPaths } from './tasks.ts'

export function createApp(runner: Runner): Hono {
  const app = new Hono()
  app.onError((err, c) => {
    const status = err instanceof RunnerError ? err.status : 500
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, status as 400)
  })
  app.notFound((c) => c.json({ error: 'not found' }, 404))

  app.get('/workflows', (c) => {
    const rows = runner.db
      .prepare('SELECT * FROM workflows ORDER BY name')
      .all() as unknown as WorkflowRow[]
    return c.json({
      workflows: rows.map((row) => ({
        id: row.id,
        name: row.name,
        comfyPath: row.comfy_path,
        currentBranch: row.current_branch,
      })),
    })
  })

  app.post('/workflows', async (c) => {
    const body = await jsonObject(c.req)
    const created = await readAndCreate(
      runner.db,
      editor(runner),
      {
        name: stringField(body, 'name'),
        comfyPath: stringField(body, 'comfyPath'),
        ...(body.message === undefined
          ? {}
          : { message: stringField(body, 'message') }),
        ...(body.adapter === undefined ? {} : { adapter: body.adapter }),
      },
      runner.now(),
    )
    return c.json(
      { id: created.workflow.id, revisionId: created.revision.id },
      201,
    )
  })

  app.post('/workflows/:name/switch', async (c) => {
    const body = await jsonObject(c.req)
    const workflow = switchBranch(
      runner.db,
      c.req.param('name'),
      stringField(body, 'branch'),
    )
    return c.json({
      name: workflow.name,
      currentBranch: workflow.current_branch,
    })
  })

  app.post('/workflows/:name/branches', async (c) => {
    const body = await jsonObject(c.req)
    const branch = createBranch(
      runner.db,
      c.req.param('name'),
      stringField(body, 'name'),
      body.revisionId === undefined
        ? undefined
        : stringField(body, 'revisionId'),
    )
    return c.json(
      { name: branch.name, headRevisionId: branch.head_revision_id },
      201,
    )
  })

  app.post('/workflows/:name/branches/:branch', async (c) => {
    const body = await jsonObject(c.req)
    const branch = moveBranch(
      runner.db,
      c.req.param('name'),
      c.req.param('branch'),
      stringField(body, 'revisionId'),
      stringField(body, 'expectedHead'),
    )
    return c.json({
      name: branch.name,
      headRevisionId: branch.head_revision_id,
    })
  })

  app.post('/workflows/:name/checkout', async (c) => {
    await checkout(runner.db, editor(runner), c.req.param('name'))
    return c.json({ ok: true })
  })

  app.post('/workflows/:name/commit', async (c) => {
    const body = await jsonObject(c.req)
    const revision = await commitHead(
      runner.db,
      editor(runner),
      c.req.param('name'),
      {
        ...(body.message === undefined
          ? {}
          : { message: stringField(body, 'message') }),
        ...(body.adapter === undefined ? {} : { adapter: body.adapter }),
      },
      runner.now(),
    )
    return c.json({ id: revision.id, version: revision.version }, 201)
  })

  app.get('/workflows/:name/revisions', (c) => {
    const workflow = workflowByName(runner.db, c.req.param('name'))
    const rows = runner.db
      .prepare(
        `SELECT id, version, message, created_at FROM workflow_revisions
         WHERE workflow_id = ? ORDER BY version`,
      )
      .all(workflow.id) as unknown as Array<{
      id: string
      version: number
      message: string | null
      created_at: string
    }>
    return c.json({
      revisions: rows.map((row) => ({
        id: row.id,
        version: row.version,
        message: row.message,
        createdAt: row.created_at,
      })),
    })
  })

  app.get('/revisions/:id/tasks', (c) => {
    revisionById(runner.db, c.req.param('id'))
    const rows = runner.db
      .prepare(
        'SELECT * FROM tasks WHERE head_revision_id = ? ORDER BY created_at',
      )
      .all(c.req.param('id')) as unknown as TaskRow[]
    return c.json({ tasks: rows.map(taskJson) })
  })

  app.post('/tasks', async (c) => {
    const body = await jsonObject(c.req)
    const executor = stringField(body, 'executor')
    if (executor !== 'comfyui' && executor !== 'llm') {
      throw new RunnerError('executor must be comfyui or llm')
    }
    const task = createTask(
      runner.db,
      {
        executor,
        task: stringField(body, 'task'),
        ...(body.workflowName === undefined
          ? {}
          : { workflowName: stringField(body, 'workflowName') }),
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
    return c.json(taskJson(task), 201)
  })

  app.get('/tasks/:id', (c) =>
    c.json(taskJson(taskById(runner.db, c.req.param('id')))),
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
      return c.json(taskJson(taskById(runner.db, task.id)))
    }
    if (task.status !== 'running') throw new RunnerError('task is not running')
    if (task.executor === 'llm') {
      runner.stops.get(task.id)?.abort()
    } else if (task.prompt_id && task.comfy_base_url) {
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
    return c.json(taskJson(taskById(runner.db, task.id)))
  })

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

  return app
}

function bytesOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

function editor(runner: Runner): ComfyClient {
  const client = runner.clients[0]
  if (!client) throw new RunnerError('no ComfyUI instance')
  return client
}

function taskJson(task: TaskRow): Record<string, unknown> {
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

async function jsonObject(req: {
  json: () => Promise<unknown>
}): Promise<Record<string, unknown>> {
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

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value === '')
    throw new RunnerError(`${key} is required`)
  return value
}

function objectField(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = body[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RunnerError(`${key} must be an object`)
  }
  return value as Record<string, unknown>
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      timeout: { type: 'string' },
    },
  })
  const root = findRepoRoot([process.cwd(), import.meta.dirname])
  const config = loadConfig(resolve(root, 'config.json'))
  const runner: Runner = {
    db: openDatabase(resolve(root, config.runner.db)),
    clients: config.runner.comfyUiBaseURLs.map(
      (baseURL) => new ComfyClient(baseURL),
    ),
    llm: config.runner.llm
      ? {
          baseURL: config.runner.llm.baseURL,
          model: config.runner.llm.model,
          concurrency: config.runner.llm.concurrency,
          timeoutMs: config.runner.llm.timeout * 1000,
        }
      : null,
    timeoutMs: timeoutMs(values.timeout, config.runner.timeout),
    now: () => new Date(),
    randomSeed: () => Math.floor(Math.random() * 2 ** 32),
    stops: new Map(),
  }
  resume(runner)
  const app = createApp(runner)
  const host = values.host ?? config.runner.host
  const port = portOf(values.port, config.runner.port)
  const timer = setInterval(() => {
    void tick(runner)
  }, 1000)
  const server = serve({ fetch: app.fetch, hostname: host, port })
  log(root, `Runner http://${host}:${port}`)
  log(root, `ComfyUI ${config.runner.comfyUiBaseURLs.join(', ')}`)
  process.once('SIGINT', () => {
    log(root, 'interrupting')
    clearInterval(timer)
    server.close()
  })
}

function log(root: string, message: string): void {
  const dir = join(root, 'data', 'logs')
  mkdirSync(dir, { recursive: true })
  appendFileSync(
    join(dir, 'runner.log'),
    `${new Date().toISOString()} ${message}\n`,
  )
  console.error(message)
}

function timeoutMs(raw: string | undefined, fallbackSeconds: number): number {
  if (raw === undefined) return fallbackSeconds * 1000
  if (!/^\d+$/.test(raw) || Number(raw) === 0) {
    throw new RunnerError('--timeout must be a positive number of seconds')
  }
  return Number(raw) * 1000
}

function portOf(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const port = Number(raw)
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new RunnerError('--port must be a number from 1 to 65535')
  }
  return port
}

if (isDirect()) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    try {
      log(findRepoRoot([process.cwd(), import.meta.dirname]), message)
    } catch {
      console.error(message)
    }
    process.exitCode = 1
  })
}

function isDirect(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(resolve(entry)).href
}
