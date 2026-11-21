import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { test } from 'node:test'

import { openDatabase } from '../db.ts'
import { ComfyClient } from '../comfy/client.ts'
import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'
import { parseProfiles } from '../train/fromDataset.ts'
import { mountTrain } from './train.ts'

// 桩 trainer：记录收到的 body，回一个固定 job
const received: { path: string; method: string; body?: unknown }[] = []
const uploads: { path: string; size: number }[] = []
const stub = new Hono()
stub.post('/train/jobs', async (c) => {
  const body = await c.req.json()
  received.push({ path: '/train/jobs', method: 'POST', body })
  return c.json({ job: { id: 'stub1', name: body.name, params: body } }, 201)
})
stub.get('/train/jobs', (c) => c.json({ jobs: [] }))
stub.get('/train/jobs/:id', (c) => c.json({ job: { id: c.req.param('id') } }))
stub.get('/train/jobs/:id/log', (c) =>
  c.text(
    `line 1 of ${c.req.param('id')}\nline 2\ntail=${c.req.query('tail') ?? 'none'}\n`,
  ),
)
stub.delete('/train/jobs/:id', (c) =>
  c.json({ job: { id: c.req.param('id'), status: 'cancelled' } }),
)
stub.post('/train/jobs/:id/pause', (c) =>
  c.json({ job: { id: c.req.param('id'), status: 'running', pausedAt: '2026-01-01' } }),
)
stub.post('/train/jobs/:id/resume', (c) =>
  c.json({ job: { id: c.req.param('id'), status: 'running', pausedAt: null } }),
)
stub.post('/upload', async (c) => {
  const bytes = await c.req.arrayBuffer()
  const entry = { path: c.req.query('path') ?? '', size: bytes.byteLength }
  uploads.push(entry)
  return c.json(entry)
})
let freeCalls = 0
stub.post('/free', (c) => {
  freeCalls += 1
  return c.json({})
})

// 与 createApp 同款错误映射：RunnerError → status
function appWithTrain(runner: Runner, profiles?: Parameters<typeof mountTrain>[2]): Hono {
  const app = new Hono()
  app.onError((err, c) => {
    const status = err instanceof RunnerError ? err.status : 500
    return c.json({ error: err.message }, status as 400)
  })
  mountTrain(app, runner, profiles)
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

const PROFILES = parseProfiles({
  profiles: {
    seed: {
      desc: '测试档',
      expectImages: [1, 10],
      params: { numRepeats: 10, maxTrainEpochs: 2, keepTokens: 1 },
    },
  },
})

// 建一个带 2 张已处理图的数据集，图片落 dataDir/capture/image/<id>.png
function seededRunner(dataDir: string): Runner {
  const db = openDatabase(join(dataDir, 'runner.sqlite'))
  const at = Date.now()
  mkdirSync(join(dataDir, 'capture', 'image'), { recursive: true })
  const insertAsset = db.prepare(
    `INSERT INTO image_assets
       (id, status, source_type, original_path, original_width, original_height,
        hash, processed_path, processed_width, processed_height, tags_json, rating,
        created_at, updated_at)
     VALUES (?, 'processed', 'manual', ?, 64, 64, ?, ?, 64, 64, ?, 'general', ?, ?)`,
  )
  for (const [i, id] of ['a1', 'a2'].entries()) {
    const rel = `capture/image/${id}.png`
    writeFileSync(join(dataDir, rel), Buffer.from([0x89, 0x50, 0x4e, 0x47, i]))
    insertAsset.run(
      id,
      rel,
      `hash-${id}`,
      rel,
      JSON.stringify(['tagA', 'tagB']),
      at,
      at,
    )
  }
  db.prepare(
    'INSERT INTO datasets (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run('d1', 'oil_sister', at, at)
  const link = db.prepare(
    'INSERT INTO dataset_assets (dataset_id, asset_id, added_at) VALUES (?, ?, ?)',
  )
  for (const id of ['a1', 'a2']) link.run('d1', id, at)
  return { ...runnerWithTrainer(null), db, dataDir }
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
    const res4 = await app.request('/train/jobs/abc/log')
    assert.equal(res4.status, 200)
    assert.match(res4.headers.get('content-type') ?? '', /text\/plain/)
    assert.match(await res4.text(), /line 1 of abc/)
    // ?tail= 原样透传给 trainer
    const res5 = await app.request('/train/jobs/abc/log?tail=2048')
    assert.match(await res5.text(), /tail=2048/)
  })
})

test('POST /train/jobs/:id/pause|resume proxy', async () => {
  await withStubTrainer(async (base) => {
    const app = appWithTrain(runnerWithTrainer(base))
    const paused = await app.request('/train/jobs/abc/pause', { method: 'POST' })
    assert.equal(paused.status, 200)
    const pausedBody = (await paused.json()) as {
      job: { id: string; pausedAt: string | null }
    }
    assert.equal(pausedBody.job.id, 'abc')
    assert.ok(pausedBody.job.pausedAt)

    const resumed = await app.request('/train/jobs/abc/resume', { method: 'POST' })
    assert.equal(resumed.status, 200)
    const resumedBody = (await resumed.json()) as {
      job: { pausedAt: string | null }
    }
    assert.equal(resumedBody.job.pausedAt, null)
  })
})

test('POST /train/jobs frees ComfyUI VRAM before creating the job', async () => {
  await withStubTrainer(async (base) => {
    freeCalls = 0
    const runner = {
      ...runnerWithTrainer(base),
      clients: [new ComfyClient(base)],
    }
    const app = appWithTrain(runner)
    const res = await app.request('/train/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'grp-c', datasetPath: 'grp-c/img' }),
    })
    assert.equal(res.status, 201)
    assert.equal(freeCalls, 1)
    assert.equal(res.headers.get('x-comfy-free'), 'freed')
  })
})

test('POST /train/jobs still creates the job when ComfyUI is unreachable', async () => {
  await withStubTrainer(async (base) => {
    const runner = {
      ...runnerWithTrainer(base),
      // 关掉的端口：/free 必失败，但不能拦住建 job
      clients: [new ComfyClient('http://127.0.0.1:1')],
    }
    const app = appWithTrain(runner)
    const res = await app.request('/train/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'grp-d', datasetPath: 'grp-d/img' }),
    })
    assert.equal(res.status, 201)
    assert.match(res.headers.get('x-comfy-free') ?? '', /^skip: /)
  })
})

test('GET /train/profiles exposes profile table and preset', async () => {  const app = appWithTrain(runnerWithTrainer('http://stub.invalid'), {
    profiles: PROFILES,
  })
  const res = await app.request('/train/profiles')
  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    profiles: { name: string; params: Record<string, unknown> }[]
    preset: Record<string, unknown>
    defaultBaseModel: string
  }
  assert.deepEqual(body.profiles.map((p) => p.name), ['seed'])
  assert.equal(body.profiles[0]!.params.maxTrainEpochs, 2)
  assert.equal(body.preset.sdxl, true)
  assert.match(body.defaultBaseModel, /animagine-xl-4\.0-zero/)
})

test('POST /train/start exports, uploads and creates job from profile', async () => {
  await withStubTrainer(async (base) => {
    uploads.length = 0
    const dataDir = mkdtempSync(join(tmpdir(), 'aigc-train-'))
    const runner = { ...seededRunner(dataDir), trainerBaseURL: base }
    const app = appWithTrain(runner, { profiles: PROFILES })
    const res = await app.request('/train/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dataset: 'oil',
        trigger: 'oil_style',
        profile: 'seed',
      }),
    })
    assert.equal(res.status, 201)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(body.dataset, 'oil_sister')
    assert.equal(body.images, 2)
    assert.equal(body.pushed, 2)
    assert.equal(body.profile, 'seed')
    const job = body.job as { id: string; name: string }
    assert.equal(job.id, 'stub1')
    assert.match(job.name, /^oil_sister-seed-az-/)
    // 2 组 × (png + txt)
    assert.deepEqual(
      uploads.map((u) => u.path).sort(),
      [
        'oil_sister/img/a1.png',
        'oil_sister/img/a1.txt',
        'oil_sister/img/a2.png',
        'oil_sister/img/a2.txt',
      ].sort(),
    )
    // caption 首 token 是触发词，格式与 export_dataset.mjs 一致
    const caption = readFileSync(
      join(dataDir, 'training-export', 'oil_sister', 'img', 'a1.txt'),
      'utf8',
    ).trim()
    assert.equal(caption, 'oil_style, tagA,tagB,')

    const sent = received.at(-1)!.body as Record<string, unknown>
    assert.equal(sent.datasetPath, 'oil_sister/img')
    assert.equal(sent.baseModel, 'checkpoints/animagine-xl-4.0-zero.safetensors')
    assert.equal(sent.keepTokens, 1)
    assert.equal(sent.numRepeats, 10)
    assert.equal(sent.maxTrainEpochs, 2)
    assert.equal(sent.sdxl, true)
    assert.equal(sent.cacheTextEncoderOutputs, true)
  })
})

test('POST /train/start dryRun neither uploads nor creates a job', async () => {
  uploads.length = 0
  const dataDir = mkdtempSync(join(tmpdir(), 'aigc-train-'))
  const runner = seededRunner(dataDir)
  const app = appWithTrain(runner, { profiles: PROFILES })
  const before = received.length
  const res = await app.request('/train/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataset: 'oil_sister', profile: 'seed', dryRun: true }),
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body.dryRun, true)
  assert.equal(body.images, 2)
  assert.equal(uploads.length, 0)
  assert.equal(received.length, before)
  // 无触发词时不强改 keepTokens（沿用 profile）
  assert.equal((body.params as Record<string, unknown>).keepTokens, 1)
})

test('POST /train/start rejects unknown profile, dataset and params', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aigc-train-'))
  const app = appWithTrain(seededRunner(dataDir), { profiles: PROFILES })
  const post = (body: Record<string, unknown>) =>
    app.request('/train/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const unknownProfile = await post({ dataset: 'oil_sister', profile: 'nope' })
  assert.equal(unknownProfile.status, 400)
  assert.match(
    ((await unknownProfile.json()) as { error: string }).error,
    /未知 profile/,
  )

  const unknownDataset = await post({ dataset: 'no-such-set' })
  assert.equal(unknownDataset.status, 404)

  const badParam = await post({
    dataset: 'oil_sister',
    params: { netwrokDim: 64 },
  })
  assert.equal(badParam.status, 400)
  assert.match(
    ((await badParam.json()) as { error: string }).error,
    /未知训练参数: netwrokDim/,
  )

  const conflict = await post({
    dataset: 'oil_sister',
    params: { shuffleCaption: true },
  })
  assert.equal(conflict.status, 400)
  assert.match(
    ((await conflict.json()) as { error: string }).error,
    /互斥/,
  )
})
