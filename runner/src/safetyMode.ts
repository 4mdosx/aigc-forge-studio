import type { DatabaseSync } from 'node:sqlite'

import { RunnerError } from './errors.ts'

export const SAFETY_MODE_KEY = 'safety_mode'

export interface SafetyMode {
  enabled: boolean
}

export function seedSafetyMode(db: DatabaseSync): void {
  const row = db.prepare('SELECT key FROM config WHERE key = ?').get(SAFETY_MODE_KEY)
  if (row) return
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run(
    SAFETY_MODE_KEY,
    JSON.stringify({ enabled: false }),
  )
}

export function readSafetyMode(db: DatabaseSync): SafetyMode {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(SAFETY_MODE_KEY) as
    | { value: string }
    | undefined
  if (!row) throw new RunnerError('safety_mode missing', 404)
  let parsed: unknown
  try {
    parsed = JSON.parse(row.value)
  } catch {
    throw new RunnerError('safety_mode is not valid JSON')
  }
  return parseSafetyMode(parsed)
}

export function saveSafetyMode(db: DatabaseSync, raw: unknown): SafetyMode {
  const mode = parseSafetyMode(raw)
  db.prepare(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SAFETY_MODE_KEY, JSON.stringify(mode))
  return mode
}

export function parseSafetyMode(raw: unknown): SafetyMode {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RunnerError('safety_mode must be an object')
  }
  const enabled = (raw as Record<string, unknown>).enabled
  if (typeof enabled !== 'boolean') throw new RunnerError('enabled must be a boolean')
  return { enabled }
}
