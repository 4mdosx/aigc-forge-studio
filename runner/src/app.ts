import { AsyncLocalStorage } from 'node:async_hooks'

import type { ComfyClient } from './comfy.ts'
import { RunnerError } from './errors.ts'

export interface App {
  root: string
  client: ComfyClient
  timeoutMs: number
  outDir: string
  signal: AbortSignal
}

const apps = new AsyncLocalStorage<App>()

export function currentApp(): App {
  const app = apps.getStore()
  if (!app) throw new RunnerError('runner is not running')
  return app
}

export function withApp<T>(app: App, run: () => Promise<T>): Promise<T> {
  return apps.run(app, run)
}
