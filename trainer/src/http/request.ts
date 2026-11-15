import type { Context } from 'hono'

import { TrainerError } from '../errors.ts'

export async function jsonObject(req: Context['req']): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = await req.json()
  } catch {
    throw new TrainerError('request body must be JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TrainerError('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

export function stringField(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TrainerError(`${key} must be a non-empty string`)
  }
  return value
}
