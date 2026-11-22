import { serve } from '@hono/node-server'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { WebSocketServer } from 'ws'

import { CaptureLive } from './capture/live.ts'
import { enqueueDownload, resumeCaptureTasks } from './capture/tasks.ts'
import { gatewayChat } from './chat/client.ts'
import { loadGateway } from './chat/env.ts'
import { ComfyClient } from './comfy/client.ts'
import { findRepoRoot, loadConfig } from './config.ts'
import { openDatabase } from './db.ts'
import { RunnerError } from './errors.ts'
import { createApp } from './http/app.ts'
import { writeWd14TagTable } from './tag/table.ts'
import { resume, tick, type Runner } from './task/queue.ts'

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
  const gateway = await loadGateway(root)
  const runner: Runner = {
    db: openDatabase(resolve(root, config.runner.db)),
    clients: config.runner.comfyUiBaseURLs.map(
      (baseURL) => new ComfyClient(baseURL),
    ),
    chat: gateway ? gatewayChat(gateway) : null,
    trainerBaseURL: config.runner.trainerBaseURL,
    timeoutMs: timeoutMs(values.timeout, config.runner.timeout),
    dataDir: resolve(root, config.runner.dataDir),
    now: () => new Date(),
    randomSeed: () => Math.floor(Math.random() * 2 ** 32),
  }
  writeWd14TagTable(runner.db, runner.dataDir)
  resume(runner)
  resumeCaptureTasks(runner.db, runner.now().getTime())
  const live = new CaptureLive({
    enqueue: (job) =>
      enqueueDownload(
        runner.db,
        {
          url: job.url,
          ...(job.mediaUrl ? { mediaUrl: job.mediaUrl } : {}),
          liveId: job.id,
        },
        runner.now().getTime(),
      ),
  })
  runner.captureLive = live
  const app = createApp(runner, live)
  const host = values.host ?? config.runner.host
  const port = portOf(values.port, config.runner.port)
  // tick 内部可能连续跑几秒（capture 有 3 秒预算），不加锁会被下一个 interval 重入。
  let ticking = false
  const timer = setInterval(() => {
    if (ticking) return
    ticking = true
    void tick(runner).finally(() => {
      ticking = false
    })
  }, 1000)
  const sockets = new WebSocketServer({ noServer: true })
  const server = serve({
    fetch: app.fetch,
    hostname: host,
    port,
    websocket: { server: sockets },
  })
  log(root, `Runner http://${host}:${port}`)
  log(root, `Capture live ws://${host}:${port}/capture/live`)
  log(root, `ComfyUI ${config.runner.comfyUiBaseURLs.join(', ')}`)
  if (config.runner.trainerBaseURL)
    log(root, `Trainer ${config.runner.trainerBaseURL}`)
  log(root, gateway ? `Gateway ${gateway.models.join(', ')}` : 'Gateway off')
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
