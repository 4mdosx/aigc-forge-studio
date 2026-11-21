import type { Hono } from 'hono'

import type { Trainer } from '../download/manager.ts'
import { TrainerError } from '../errors.ts'
import {
  cancelTrainJob,
  createTrainJob,
  listTrainJobs,
  pauseTrainJob,
  readTrainLog,
  resumeTrainJob,
  trainJobJson,
  type TrainJobRow,
} from '../train/manager.ts'
import type { TrainParamsInput } from '../train/toml.ts'
import { jsonObject, stringField } from './request.ts'

const STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled']

// POST /train/jobs 的白名单字段：多余字段直接拒绝（runner work semantic 同款教训）
const FIELDS = [
  'name',
  'datasetRoot',
  'datasetPath',
  'baseModel',
  'resolution',
  'batchSize',
  'numRepeats',
  'networkDim',
  'networkAlpha',
  'unetLr',
  'textEncoderLr',
  'scheduler',
  'lrWarmupSteps',
  'maxTrainEpochs',
  'saveEveryNEpochs',
  'clipSkip',
  'minSnrGamma',
  'sdpa',
  'unetOnly',
  'sdxl',
  'cacheTextEncoderOutputs',
  'shuffleCaption',
  'keepTokens',
  'samplePrompts',
  'sampleEveryNEpochs',
] as const

function trainParamsOf(body: Record<string, unknown>): TrainParamsInput {
  const unknown = Object.keys(body).filter(
    (key) => !FIELDS.includes(key as (typeof FIELDS)[number]),
  )
  if (unknown.length > 0) {
    throw new TrainerError(`unknown fields: ${unknown.join(', ')}`)
  }
  return {
    name: stringField(body, 'name'),
    datasetRoot: stringField(body, 'datasetRoot'),
    datasetPath: stringField(body, 'datasetPath'),
    baseModel: stringField(body, 'baseModel'),
    resolution: body.resolution as number | undefined,
    batchSize: body.batchSize as number | undefined,
    numRepeats: body.numRepeats as number | undefined,
    networkDim: body.networkDim as number | undefined,
    networkAlpha: body.networkAlpha as number | undefined,
    unetLr: body.unetLr as number | undefined,
    textEncoderLr: body.textEncoderLr as number | undefined,
    scheduler: body.scheduler as TrainParamsInput['scheduler'] | undefined,
    lrWarmupSteps: body.lrWarmupSteps as number | undefined,
    maxTrainEpochs: body.maxTrainEpochs as number | undefined,
    saveEveryNEpochs: body.saveEveryNEpochs as number | undefined,
    clipSkip: body.clipSkip as number | undefined,
    minSnrGamma: body.minSnrGamma as number | undefined,
    sdpa: body.sdpa as boolean | undefined,
    unetOnly: body.unetOnly as boolean | undefined,
    sdxl: body.sdxl as boolean | undefined,
    cacheTextEncoderOutputs: body.cacheTextEncoderOutputs as boolean | undefined,
    shuffleCaption: body.shuffleCaption as boolean | undefined,
    keepTokens: body.keepTokens as number | undefined,
    samplePrompts: body.samplePrompts as string | undefined,
    sampleEveryNEpochs: body.sampleEveryNEpochs as number | undefined,
  }
}

export function mountTrain(app: Hono, trainer: Trainer): void {
  app.post('/train/jobs', async (c) => {
    const body = await jsonObject(c.req)
    const row = createTrainJob(trainer, trainParamsOf(body))
    return c.json({ job: trainJobJson(row) }, 201)
  })

  app.get('/train/jobs', (c) => {
    const status = c.req.query('status')
    if (status && !STATUSES.includes(status)) {
      throw new TrainerError(`status must be one of: ${STATUSES.join(', ')}`)
    }
    return c.json({
      jobs: listTrainJobs(trainer.db, status).map((row: TrainJobRow) =>
        trainJobJson(row),
      ),
    })
  })

  app.get('/train/jobs/:id', (c) => {
    const row = trainer.db
      .prepare('SELECT * FROM train_jobs WHERE id = ?')
      .get(c.req.param('id')) as TrainJobRow | undefined
    if (!row) throw new TrainerError('train job not found', 404)
    return c.json(trainJobJson(row))
  })

  app.get('/train/jobs/:id/log', (c) => {
    // 先确认 job 存在再读日志，错误语义才对
    const row = trainer.db
      .prepare('SELECT id FROM train_jobs WHERE id = ?')
      .get(c.req.param('id')) as { id: string } | undefined
    if (!row) throw new TrainerError('train job not found', 404)
    const tail = Number(c.req.query('tail') ?? '')
    return c.text(
      readTrainLog(trainer.train, row.id, Number.isFinite(tail) ? tail : undefined),
    )
  })

  app.post('/train/jobs/:id/pause', async (c) => {
    const row = await pauseTrainJob(trainer, c.req.param('id'))
    return c.json({ job: trainJobJson(row) })
  })

  app.post('/train/jobs/:id/resume', async (c) => {
    const row = await resumeTrainJob(trainer, c.req.param('id'))
    return c.json({ job: trainJobJson(row) })
  })

  app.delete('/train/jobs/:id', async (c) => {
    const row = await cancelTrainJob(trainer, c.req.param('id'))
    return c.json({ job: trainJobJson(row) })
  })
}
