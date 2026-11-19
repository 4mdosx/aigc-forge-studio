import type { Hono } from 'hono'

import {
  addDatasetAssets,
  assetIdsOf,
  createDataset,
  datasetById,
  datasetNameOf,
  deleteDataset,
  listDatasets,
  removeDatasetAssets,
  renameDataset,
} from '../dataset/records.ts'
import type { Runner } from '../task/queue.ts'
import { jsonObject } from './request.ts'

// 数据集是导出训练集的名单：名字 + image_assets id。
// GET 返回 assetIds；成员的增删都是幂等的。

export function mountDatasets(app: Hono, runner: Runner): void {
  app.get('/datasets', (c) => {
    return c.json({ datasets: listDatasets(runner.db) })
  })

  app.post('/datasets', async (c) => {
    const body = await jsonObject(c.req)
    const dataset = createDataset(
      runner.db,
      datasetNameOf(body.name),
      now(runner),
    )
    return c.json(dataset, 201)
  })

  app.get('/datasets/:id', (c) => {
    return c.json(datasetById(runner.db, c.req.param('id')))
  })

  app.patch('/datasets/:id', async (c) => {
    const body = await jsonObject(c.req)
    return c.json(
      renameDataset(
        runner.db,
        c.req.param('id'),
        datasetNameOf(body.name),
        now(runner),
      ),
    )
  })

  app.delete('/datasets/:id', (c) => {
    deleteDataset(runner.db, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/datasets/:id/assets', async (c) => {
    const body = await jsonObject(c.req)
    const { dataset, added } = addDatasetAssets(
      runner.db,
      c.req.param('id'),
      assetIdsOf(body.ids),
      now(runner),
    )
    return c.json({ ...dataset, added })
  })

  app.delete('/datasets/:id/assets', async (c) => {
    const body = await jsonObject(c.req)
    const { dataset, removed } = removeDatasetAssets(
      runner.db,
      c.req.param('id'),
      assetIdsOf(body.ids),
      now(runner),
    )
    return c.json({ ...dataset, removed })
  })
}

function now(runner: Runner): number {
  return runner.now().getTime()
}
