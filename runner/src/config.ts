import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { RunnerError } from './errors.ts'

export interface AppConfig {
  baseURL: string
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

  const baseURL = (raw as { baseURL?: unknown }).baseURL
  if (typeof baseURL !== 'string' || baseURL.trim() === '') {
    throw new RunnerError(`baseURL missing in ${path}`)
  }

  return { baseURL: baseURL.trim().replace(/\/+$/, '') }
}

export function findRepoRoot(starts: string[]): string {
  for (const start of starts) {
    let dir = resolve(start)
    for (;;) {
      if (existsSync(join(dir, 'infra', 'config.json'))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  throw new RunnerError('infra/config.json not found')
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
