import { Hono } from 'hono'

import type { Trainer } from '../download/manager.ts'
import { TrainerError } from '../errors.ts'
import { mountDownloads } from './downloads.ts'
import { mountRoots } from './roots.ts'
import { mountSystem } from './system.ts'
import { mountTrain } from './train.ts'
import { mountUpload } from './upload.ts'

export function createApp(trainer: Trainer): Hono {
  const app = new Hono()
  app.onError((err, c) => {
    const status = err instanceof TrainerError ? err.status : 500
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, status as 400)
  })
  app.notFound((c) => c.json({ error: 'not found' }, 404))
  app.get('/health', (c) => c.json({ ok: true }))
  mountSystem(app)
  mountRoots(app, trainer)
  mountUpload(app, trainer)
  mountDownloads(app, trainer)
  mountTrain(app, trainer)
  return app
}
