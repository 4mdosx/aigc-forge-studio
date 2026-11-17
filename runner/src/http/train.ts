import type { Hono } from 'hono'

import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'
import { jsonObject } from './request.ts'

// 训练发起台：把「发一次训练」固化成 runner 接口。
// POST /train/jobs 用稳定档预设补全默认值后透传给训练机 trainer（:8788），
// 其余路由纯代理。runner 不复制 trainer 的校验逻辑——字段校验以 trainer 为准。

// SDXL 风格 LoRA 稳定档（2026-11-17 定案：bf16/unet_only/TE cache，速度 2.2s/it）。
// 调用方只须给 name + datasetPath，其余按需覆盖。
const STABLE_PRESET: Record<string, unknown> = {
  datasetRoot: 'training',
  baseModel: 'checkpoints/pdv10.safetensors',
  resolution: 1024,
  batchSize: 1,
  numRepeats: 10,
  networkDim: 128,
  networkAlpha: 32,
  unetLr: 0.0004,
  textEncoderLr: 0.00005,
  scheduler: 'constant',
  lrWarmupSteps: 100,
  maxTrainEpochs: 3,
  saveEveryNEpochs: 1,
  clipSkip: 2,
  minSnrGamma: 5,
  sdpa: true,
  unetOnly: true,
  sdxl: true,
  shuffleCaption: false,
  cacheTextEncoderOutputs: true,
  keepTokens: 0,
}

function trainerOf(runner: Runner): string {
  if (!runner.trainerBaseURL) {
    throw new RunnerError(
      'trainer not configured: set runner.trainerBaseURL in config.json',
      503,
    )
  }
  return runner.trainerBaseURL
}

async function proxy(
  runner: Runner,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const base = trainerOf(runner)
  let res: Response
  try {
    res = await fetch(`${base}${path}`, init)
  } catch (err) {
    throw new RunnerError(
      `trainer unreachable at ${base}: ${err instanceof Error ? err.message : String(err)}`,
      502,
    )
  }
  const text = await res.text()
  return new Response(text, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  })
}

export function mountTrain(app: Hono, runner: Runner): void {
  app.post('/train/jobs', async (c) => {
    const body = await jsonObject(c.req)
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      throw new RunnerError('name is required')
    }
    if (typeof body.datasetPath !== 'string' || body.datasetPath.trim() === '') {
      throw new RunnerError('datasetPath is required')
    }
    const merged = { ...STABLE_PRESET, ...body }
    return proxy(runner, '/train/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(merged),
    })
  })

  app.get('/train/jobs', (c) => proxy(runner, '/train/jobs'))

  app.get('/train/jobs/:id', (c) =>
    proxy(runner, `/train/jobs/${c.req.param('id')}`),
  )

  app.delete('/train/jobs/:id', (c) =>
    proxy(runner, `/train/jobs/${c.req.param('id')}`, { method: 'DELETE' }),
  )
}
