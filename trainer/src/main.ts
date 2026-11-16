import { serve } from '@hono/node-server'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'

import { openDatabase } from './db.ts'
import type { Trainer } from './download/manager.ts'
import { recover } from './download/manager.ts'
import { TrainerError } from './errors.ts'
import { createApp } from './http/app.ts'
import { buildRoots } from './roots.ts'
import { recoverTrainJobs } from './train/manager.ts'

interface Config {
  trainer: {
    host: string
    port: number
    db: string
    roots?: Record<string, string>
    train?: {
      sdScriptsRoot: string
      numCpuThreads?: number
      logsDir?: string
    }
  }
}

function loadConfig(path: string): Config {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const config = raw as Config
  if (!config?.trainer) throw new TrainerError('config.json lacks trainer section')
  return config
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
    },
  })
  // config.json 与 data/ 都锚在 trainer 包根（import.meta.dirname 是 src/）
  const root = join(import.meta.dirname, '..')
  const config = loadConfig(resolve(root, 'config.json'))
  // 训练日志目录：config 不给就落 trainer 包根 data/train
  const trainConfig = config.trainer.train
    ? {
        ...config.trainer.train,
        logsDir: resolve(
          root,
          config.trainer.train.logsDir ?? join('data', 'train'),
        ),
      }
    : undefined
  if (trainConfig) mkdirSync(trainConfig.logsDir, { recursive: true })
  const trainer: Trainer = {
    db: openDatabase(resolve(root, config.trainer.db)),
    roots: buildRoots(config.trainer.roots),
    controllers: new Map(),
    runs: new Map(),
    trainRuns: new Map(),
    train: trainConfig,
    now: () => new Date(),
  }
  recover(trainer)
  recoverTrainJobs(trainer)
  const app = createApp(trainer)
  const host = values.host ?? config.trainer.host
  const port = portOf(values.port ?? String(config.trainer.port))
  const server = serve({ fetch: app.fetch, hostname: host, port })
  log(root, `Trainer http://${host}:${port}`)
  process.once('SIGINT', () => {
    log(root, 'interrupting')
    server.close()
  })
}

function log(root: string, message: string): void {
  const dir = join(root, 'data', 'logs')
  mkdirSync(dir, { recursive: true })
  appendFileSync(
    join(dir, 'trainer.log'),
    `${new Date().toISOString()} ${message}\n`,
  )
  console.error(message)
}

function portOf(raw: string): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TrainerError('--port must be a number from 1 to 65535')
  }
  return port
}

if (isDirect()) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(message)
    process.exitCode = 1
  })
}

function isDirect(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(resolve(entry)).href
}
