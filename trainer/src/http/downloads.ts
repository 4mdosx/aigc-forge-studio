import type { Hono } from 'hono'

import {
  cancel,
  createOrAttach,
  downloadJson,
  listDownloads,
  retry,
  type DownloadRow,
  type Trainer,
} from '../download/manager.ts'
import { TrainerError } from '../errors.ts'
import { jsonObject, stringField } from './request.ts'

const STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled']

export function mountDownloads(app: Hono, trainer: Trainer): void {
  app.get('/downloads', (c) => {
    const status = c.req.query('status')
    if (status && !STATUSES.includes(status)) {
      throw new TrainerError(`status must be one of: ${STATUSES.join(', ')}`)
    }
    return c.json({
      downloads: listDownloads(trainer.db, status).map(downloadJson),
    })
  })

  app.post('/downloads', async (c) => {
    const body = await jsonObject(c.req)
    const url = stringField(body, 'url')
    const root = stringField(body, 'root')
    const path = stringField(body, 'path')
    const { row, outcome } = createOrAttach(trainer, { url, root, path })
    return c.json(
      { outcome, download: downloadJson(row) },
      outcome === 'created' ? 201 : 200,
    )
  })

  app.get('/downloads/:id', (c) => {
    const row = trainer.db
      .prepare('SELECT * FROM downloads WHERE id = ?')
      .get(c.req.param('id')) as DownloadRow | undefined
    if (!row) throw new TrainerError('download not found', 404)
    return c.json(downloadJson(row))
  })

  app.post('/downloads/:id/retry', async (c) => {
    const row = retry(trainer, c.req.param('id'))
    return c.json({ download: downloadJson(row) })
  })

  app.delete('/downloads/:id', async (c) => {
    const row = await cancel(trainer, c.req.param('id'))
    return c.json({ download: downloadJson(row) })
  })
}
