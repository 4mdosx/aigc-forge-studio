import type { DatabaseSync } from 'node:sqlite'

import { RunnerError } from './errors.ts'

export const ROLL_CONFIG_KEY = 'roll_config'

export interface RollConfig {
  workflowName: string
  version: string
  step: string
  workflowPositive: string
  workflowNegative: string
}

// 与改配置之前 dice 出图写死的值一致；version 空字符串表示走该工作流 main head
export const DEFAULT_ROLL_CONFIG: RollConfig = {
  workflowName: 'baseline_v1',
  version: 'g3317g3t',
  step: '1200',
  workflowPositive: '',
  workflowNegative: '',
}

export function seedRollConfig(db: DatabaseSync): void {
  const row = db
    .prepare('SELECT key FROM config WHERE key = ?')
    .get(ROLL_CONFIG_KEY)
  if (row) return
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run(
    ROLL_CONFIG_KEY,
    JSON.stringify(DEFAULT_ROLL_CONFIG),
  )
}

export function readRollConfig(db: DatabaseSync): RollConfig {
  const row = db
    .prepare('SELECT value FROM config WHERE key = ?')
    .get(ROLL_CONFIG_KEY) as { value: string } | undefined
  if (!row) throw new RunnerError('roll_config missing', 404)
  let parsed: unknown
  try {
    parsed = JSON.parse(row.value)
  } catch {
    throw new RunnerError('roll_config is not valid JSON')
  }
  return parseRollConfig(parsed)
}

export function saveRollConfig(db: DatabaseSync, raw: unknown): RollConfig {
  const config = parseRollConfig(raw)
  db.prepare(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(ROLL_CONFIG_KEY, JSON.stringify(config))
  return config
}

export function parseRollConfig(raw: unknown): RollConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RunnerError('roll_config must be an object')
  }
  const body = raw as Record<string, unknown>
  return {
    workflowName: requiredString(body.workflowName, 'workflowName'),
    version: optionalString(body.version, 'version'),
    step: requiredString(body.step, 'step'),
    workflowPositive: optionalString(body.workflowPositive, 'workflowPositive'),
    workflowNegative: optionalString(body.workflowNegative, 'workflowNegative'),
  }
}

export function joinPrompt(fixed: string, rolled: string): string {
  return [fixed, rolled]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(', ')
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RunnerError(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function optionalString(value: unknown, name: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new RunnerError(`${name} must be a string`)
  return value.trim()
}
