import assert from 'node:assert/strict'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { test } from 'node:test'

import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'
import { mountTrain } from './train.ts'

// 桩 trainer：记录收到的 body，回一个固定 job
const received: { path: string; method: string; body?: unknown }[] = []
const stub = new Hono()
stub.post('/train/jobs', async (c) => {
  const body = await c.req.json()
  received.push({ path: '/train/jobs', method: 'POST', body })
  return c.json({ job: { id: 'stub1', name: body.name, params: body } }, 201)
})
stub.get('/train/jobs', (c) => c.json({ jobs: [] }))
stub.get('/train/jobs/:id', (c) => c.json({ job: { id: c.req.param('id') } }))
stub.delete('/train/jobs/:id', (c) =>
  c.json({ job: { id: c.req.param('id'), status: 'cancelled' } }),
)

// 与 createApp 同款错误映射：RunnerError → status
function appWithTrain(runner: Runner): Hono {
  const app = new Hono()
  app.onError((err, c) => {
    const status = err instanceof RunnerError ? err.status : 500
    return c.json({ error: err.message }, status as 400)
  })
  mountTrain(app, runner)
  return app
}

function runnerWithTrainer(baseURL: string | null): Runner {  return {
    db: null as never,
    clients: [],
    chat: null,
    trainerBaseURL: baseURL,
    timeoutMs: 600_000,
    dataDir: '/tmp/aigc-runner-test-data',
    now: () => new Date(),
    randomSeed: () => 42,
  }
}

async function withStubTrainer(
  fn: (baseURL: string) => Promise<void>,
): Promise<void> {
  const server = serve({ fetch: stub.fetch, hostname: '127.0.0.1', port: 0 })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    const addr = server.address()
    if (addr === null || typeof addr === 'string') throw new Error('no port')
    await fn(`http://127.0.0.1:${addr.port}`)
  } finally {
    server.close()
  }
}

test('POST /train/jobs fills stable preset and forwards', async () => {
  await withStubTrainer(async (base) => {
    const app = appWithTrain(runnerWithTrainer(base))
    const res = await app.request('/train/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'grp-a', datasetPath: 'grp-a/img' }),
    })
    assert.equal(res.status, 201)
    const sent = received.at(-1)!.body as Record<string, unknown>
    assert.equal(sent.name, 'grp-a')
    assert.equal(sent.datasetPath, 'grp-a/img')
    assert.equal(sent.baseModel, 'checkpoints/pdv10.safetensors')
    assert.equal(sent.sdxl, true)
    assert.equal(sent.unetOnly, true)
    assert.equal(sent.cacheTextEncoderOutputs, true)
    assert.equal(sent.shuffleCaption, false)
    assert.equal(sent.networkDim, 128)
    // 调用方可覆盖预设
    const res2 = await app.request('/train/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'grp-b',
        datasetPath: 'grp-b/img',
        networkDim: 64,
      }),
    })
    assert.equal(res2.status, 201)
    const sent2 = received.at(-1)!.body as Record<string, unknown>
    assert.equal(sent2.networkDim, 64)
    assert.equal(sent2.numRepeats, 10)
  })
})

test('POST /train/jobs requires name and datasetPath', async () => {
  const app = appWithTrain(runnerWithTrainer('http://stub.invalid'))
  const res = await app.request('/train/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x' }),
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: string }
  assert.match(body.error, /datasetPath/)
})

test('runner without trainerBaseURL returns 503', async () => {
  const app = appWithTrain(runnerWithTrainer(null))
  const res = await app.request('/train/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x', datasetPath: 'y' }),
  })
  assert.equal(res.status, 503)
  const res2 = await app.request('/train/jobs')
  assert.equal(res2.status, 503)
})

test('GET/DELETE /train/jobs/:id proxy passthrough', async () => {
  await withStubTrainer(async (base) => {
    const app = appWithTrain(runnerWithTrainer(base))
    const res = await app.request('/train/jobs/abc')
    assert.equal(res.status, 200)
    const body = (await res.json()) as { job: { id: string } }
    assert.equal(body.job.id, 'abc')
    const res2 = await app.request('/train/jobs/abc', { method: 'DELETE' })
    assert.equal(res2.status, 200)
    const body2 = (await res2.json()) as { job: { status: string } }
    assert.equal(body2.job.status, 'cancelled')
    const res3 = await app.request('/train/jobs')
    assert.equal(res3.status, 200)
  })
})
