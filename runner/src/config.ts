import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { RunnerError } from './errors.ts'

export interface AppConfig {
  comfyui: {
    baseURL: string
  }
  runner: {
    comfyUiBaseURLs: string[]
    trainerBaseURL: string | null
    host: string
    port: number
    timeout: number
    out: string
    db: string
    dataDir: string
  }
}

export function loadConfig(path: string): AppConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  } catch (err) {
    throw new RunnerError(`cannot read ${path}: ${messageOf(err)}`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new RunnerError(`invalid JSON in ${path}: ${messageOf(err)}`)
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RunnerError(`${path} must be a JSON object`)
  }

  const comfyui = section(raw, 'comfyui', path)
  const runner = section(raw, 'runner', path)
  const baseURL = urlOf(comfyui, path)
  return {
    comfyui: { baseURL },
    runner: {
      comfyUiBaseURLs: comfyUrlsOf(runner, baseURL, path),
      trainerBaseURL: trainerUrlOf(runner),
      host: hostOf(runner, path),
      port: portOf(runner, path),
      timeout: timeoutOf(runner, path),
      out: outOf(runner, path),
      db: dbOf(runner),
      dataDir: dataDirOf(runner),
    },
  }
}

export function findRepoRoot(starts: string[]): string {
  for (const start of starts) {
    let dir = resolve(start)
    for (;;) {
      if (
        existsSync(join(dir, 'config.json')) &&
        existsSync(join(dir, 'infra'))
      )
        return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  throw new RunnerError('config.json not found')
}

function section(
  raw: object,
  key: string,
  path: string,
): Record<string, unknown> {
  const value = (raw as Record<string, unknown>)[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RunnerError(`${key} missing in ${path}`)
  }
  return value as Record<string, unknown>
}

function urlOf(comfyui: Record<string, unknown>, path: string): string {
  const baseURL = comfyui.baseURL
  if (typeof baseURL !== 'string' || baseURL.trim() === '') {
    throw new RunnerError(`comfyui.baseURL missing in ${path}`)
  }
  return baseURL.trim().replace(/\/+$/, '')
}

function comfyUrlsOf(
  runner: Record<string, unknown>,
  fallback: string,
  path: string,
): string[] {
  const list = runner.comfyUiBaseURLs
  if (list === undefined) return [comfyUrlOf(runner, fallback, path)]
  if (!Array.isArray(list) || list.length === 0) {
    throw new RunnerError(
      `runner.comfyUiBaseURLs must be a non-empty array in ${path}`,
    )
  }
  return list.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new RunnerError(
        `runner.comfyUiBaseURLs[${index}] must be a URL in ${path}`,
      )
    }
    return item.trim().replace(/\/+$/, '')
  })
}

// 训练机 trainer 服务地址：可选；未配置时 runner 的 /train/* 路由返回 503
function trainerUrlOf(runner: Record<string, unknown>): string | null {
  const value = runner.trainerBaseURL
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.trim() === '') return null
  return value.trim().replace(/\/+$/, '')
}

function comfyUrlOf(
  runner: Record<string, unknown>,
  fallback: string,
  path: string,
): string {  if (!Object.hasOwn(runner, 'comfyUiBaseURL') || runner.comfyUiBaseURL == null)
    return fallback
  const value = runner.comfyUiBaseURL
  if (typeof value !== 'string') {
    throw new RunnerError(`runner.comfyUiBaseURL must be a string in ${path}`)
  }
  const trimmed = value.trim()
  if (trimmed === '') return fallback
  return trimmed.replace(/\/+$/, '')
}

function hostOf(runner: Record<string, unknown>, path: string): string {
  const host = runner.host
  if (typeof host !== 'string' || host.trim() === '') {
    throw new RunnerError(`runner.host missing in ${path}`)
  }
  return host.trim()
}

function portOf(runner: Record<string, unknown>, path: string): number {
  const port = runner.port
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new RunnerError(
      `runner.port must be an integer from 1 to 65535 in ${path}`,
    )
  }
  return port
}

function timeoutOf(runner: Record<string, unknown>, path: string): number {
  const timeout = runner.timeout
  if (
    typeof timeout !== 'number' ||
    !Number.isInteger(timeout) ||
    timeout < 1
  ) {
    throw new RunnerError(
      `runner.timeout must be a positive number of seconds in ${path}`,
    )
  }
  return timeout
}

function outOf(runner: Record<string, unknown>, path: string): string {
  const out = runner.out
  if (typeof out !== 'string' || out.trim() === '') {
    throw new RunnerError(`runner.out missing in ${path}`)
  }
  return out.trim()
}

function dbOf(runner: Record<string, unknown>): string {
  const db = runner.db
  if (db === undefined) return 'data/runner.sqlite'
  if (typeof db !== 'string' || db.trim() === '') {
    throw new RunnerError('runner.db must be a path')
  }
  return db.trim()
}

function dataDirOf(runner: Record<string, unknown>): string {
  const dataDir = runner.dataDir
  if (dataDir === undefined) return 'data'
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw new RunnerError('runner.dataDir must be a path')
  }
  return dataDir.trim()
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
