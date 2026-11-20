import type { Hono } from 'hono'

import { RunnerError } from '../errors.ts'
import {
  readRollConfig,
  ROLL_CONFIG_KEY,
  saveRollConfig,
} from '../rollConfig.ts'
import {
  readSafetyMode,
  SAFETY_MODE_KEY,
  saveSafetyMode,
} from '../safetyMode.ts'
import type { Runner } from '../task/queue.ts'
import { jsonObject } from './request.ts'

export function mountConfig(app: Hono, runner: Runner): void {
  app.get('/config/:key', (c) => {
    const key = c.req.param('key')
    if (key === ROLL_CONFIG_KEY) return c.json({ key, value: readRollConfig(runner.db) })
    if (key === SAFETY_MODE_KEY) return c.json({ key, value: readSafetyMode(runner.db) })
    throw new RunnerError('unknown config key', 404)
  })

  app.put('/config/:key', async (c) => {
    const key = c.req.param('key')
    const body = await jsonObject(c.req)
    if (key === ROLL_CONFIG_KEY) return c.json({ key, value: saveRollConfig(runner.db, body) })
    if (key === SAFETY_MODE_KEY) return c.json({ key, value: saveSafetyMode(runner.db, body) })
    throw new RunnerError('unknown config key', 404)
  })
}
