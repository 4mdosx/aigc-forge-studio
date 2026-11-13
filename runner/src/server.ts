import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { cutout } from '../task/cutout.ts'
import { removeBg } from '../task/remove-bg.ts'
import { text2img } from '../task/text2img.ts'
import { type App, withApp } from './app.ts'
import { ComfyClient } from './comfy.ts'
import { findRepoRoot, loadConfig } from './config.ts'
import { RunnerError } from './errors.ts'
import type { TaskResult } from './adapter.ts'

const MAX_BODY = 1_000_000

export function createServer(app: App): Server {
  const server = createHttp((req, res) => {
    void handle(app, req, res)
  })
  server.requestTimeout = 0
  return server
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '8787' },
      timeout: { type: 'string' },
      out: { type: 'string' },
    },
  })
  const root = findRepoRoot([process.cwd(), import.meta.dirname])
  const config = loadConfig(resolve(root, 'infra/config.json'))
  const shutdown = new AbortController()
  const app: App = {
    root,
    client: new ComfyClient(config.baseURL, {
      onPromptId: (promptId) => console.error(`prompt_id ${promptId}`),
    }),
    timeoutMs: timeoutMs(values.timeout),
    outDir: resolve(values.out ?? join(root, 'outputs', 'runner')),
    signal: shutdown.signal,
  }
  const server = createServer(app)
  const port = portOf(values.port)
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, values.host, () => resolveListen())
  })
  console.error(`Runner http://${values.host}:${port}`)
  console.error(`ComfyUI ${config.baseURL}`)
  process.once('SIGINT', () => {
    console.error('interrupting')
    shutdown.abort()
    server.close()
  })
}

async function handle(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const request = new AbortController()
  const stop = () => request.abort()
  if (app.signal.aborted) request.abort()
  else app.signal.addEventListener('abort', stop, { once: true })
  res.on('close', () => {
    if (!res.writableEnded) request.abort()
  })

  try {
    if (req.method !== 'POST') {
      send(res, 405, { error: 'POST only' })
      return
    }
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes[path]
    if (!route) {
      send(res, 404, { error: 'not found' })
      return
    }
    const result = await withApp({ ...app, signal: request.signal }, () =>
      route(parseJson(await readBody(req))),
    )
    send(res, 200, result)
  } catch (err) {
    if (res.writableEnded || res.destroyed) return
    const aborted = request.signal.aborted && messageOf(err) === 'interrupted'
    try {
      send(res, aborted ? 499 : statusOf(err), { error: messageOf(err) })
    } catch {
      // The client closed the socket before the error body was written.
    }
  } finally {
    app.signal.removeEventListener('abort', stop)
  }
}

const routes: Record<string, (body: unknown) => Promise<TaskResult>> = {
  '/text2img': (body) => {
    const input = fields(body, ['text', 'entry'])
    return text2img({ text: input.text, entry: input.entry })
  },
  '/remove-bg': (body) => {
    const input = fields(body, ['path', 'adapter'])
    return removeBg({ path: input.path, adapter: input.adapter })
  },
  '/cutout': (body) => {
    const input = fields(body, ['text'], ['entry', 'adapter'])
    return cutout({
      text: input.text,
      ...(input.entry ? { entry: input.entry } : {}),
      ...(input.adapter ? { adapter: input.adapter } : {}),
    })
  },
}

function fields(body: unknown, required: string[], optional: string[] = []): Record<string, string> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RunnerError('body must be a JSON object')
  }
  const allowed = new Set([...required, ...optional])
  const record = body as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new RunnerError(`unknown field ${key}`)
  }
  const input: Record<string, string> = {}
  for (const key of required) input[key] = stringField(record, key, true)
  for (const key of optional) {
    if (record[key] !== undefined) input[key] = stringField(record, key, true)
  }
  return input
}

function stringField(record: Record<string, unknown>, key: string, required: boolean): string {
  const value = record[key]
  if (value === undefined) {
    if (required) throw new RunnerError(`${key} is required`)
    return ''
  }
  if (typeof value !== 'string' || value === '') {
    throw new RunnerError(`${key} must be a string`)
  }
  return value
}

function parseJson(text: string): unknown {
  if (text.trim() === '') throw new RunnerError('body must be a JSON object')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new RunnerError('invalid JSON')
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (err: unknown) => {
      if (settled) return
      settled = true
      reject(err instanceof Error ? err : new RunnerError(String(err)))
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        fail(new RunnerError('body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolveBody(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', fail)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function statusOf(err: unknown): number {
  return err instanceof RunnerError ? 400 : 500
}

function messageOf(err: unknown): string {
  if (err instanceof SyntaxError) return 'invalid JSON'
  return err instanceof Error ? err.message : String(err)
}

function timeoutMs(raw: string | undefined): number {
  if (raw === undefined) return 600_000
  if (!/^\d+$/.test(raw) || Number(raw) === 0) {
    throw new RunnerError('--timeout must be a positive number of seconds')
  }
  return Number(raw) * 1000
}

function portOf(raw: string | undefined): number {
  if (raw === undefined) return 8787
  const port = Number(raw)
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new RunnerError('--port must be a number from 1 to 65535')
  }
  return port
}

if (isDirect()) {
  main().catch((err: unknown) => {
    console.error(messageOf(err))
    process.exitCode = 1
  })
}

function isDirect(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(resolve(entry)).href
}
