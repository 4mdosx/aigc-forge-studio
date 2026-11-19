import type { Hono } from 'hono'

import { RunnerError } from '../errors.ts'
import {
  readRollConfig,
  ROLL_CONFIG_KEY,
  saveRollConfig,
} from '../rollConfig.ts'
import type { Runner } from '../task/queue.ts'
import { jsonObject } from './request.ts'

export function mountConfig(app: Hono, runner: Runner): void {
  app.get('/config/:key', (c) => {
    const key = c.req.param('key')
    if (key !== ROLL_CONFIG_KEY) throw new RunnerError('unknown config key', 404)
    return c.json({ key, value: readRollConfig(runner.db) })
  })

  app.put('/config/:key', async (c) => {
    const key = c.req.param('key')
    if (key !== ROLL_CONFIG_KEY) throw new RunnerError('unknown config key', 404)
    const value = saveRollConfig(runner.db, await jsonObject(c.req))
    return c.json({ key, value })
  })
}
