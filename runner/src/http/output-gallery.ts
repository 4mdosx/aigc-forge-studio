import type { Hono } from 'hono'

import {
  approveOutput,
  listOutputAssets,
  OUTPUT_STATUSES,
  outputDetail,
  outputImage,
  rejectOutput,
} from '../output/gallery.ts'
import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'
import { bytesOf } from './request.ts'

function intParam(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw)) throw new RunnerError('参数必须是非负整数')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > max) throw new RunnerError('参数超出范围')
  return value
}

// 产出图库：项目生成图审核。列表从 jobs 派生，审核状态落 output_assets。
export function mountOutputGallery(app: Hono, runner: Runner): void {
  app.get('/output/assets', (c) => {
    const status = c.req.query('status')
    if (status && status !== 'all' && !OUTPUT_STATUSES.includes(status as (typeof OUTPUT_STATUSES)[number])) {
      throw new RunnerError('status 必须是 pending、approved 或 rejected')
    }
    return c.json(
      listOutputAssets(runner.db, {
        status,
        offset: intParam(c.req.query('offset'), 0, 1_000_000),
        size: intParam(c.req.query('size'), 60, 200) || 60,
      }),
    )
  })

  app.get('/output/assets/:id', async (c) => {
    return c.json(await outputDetail(runner, c.req.param('id')))
  })

  app.get('/output/image/:id', async (c) => {
    const file = await outputImage(runner, c.req.param('id'))
    return c.body(bytesOf(file.bytes), 200, { 'content-type': file.contentType })
  })

  app.post('/output/assets/:id/approve', async (c) => {
    return c.json(await approveOutput(runner, c.req.param('id')))
  })

  app.post('/output/assets/:id/reject', (c) => {
    return c.json(rejectOutput(runner, c.req.param('id')))
  })
}
