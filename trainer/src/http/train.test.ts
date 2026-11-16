import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { openDatabase } from '../db.ts'
import { createApp } from './app.ts'
import { buildRoots } from '../roots.ts'
import type { Trainer } from '../download/manager.ts'

const FAKE_TRAIN = `
setTimeout(() => process.exit(Number(process.argv[2] ?? 0)), Number(process.argv[3] ?? 50))
`

let trainer: Trainer
let tmp: string
let app: ReturnType<typeof createApp>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'trainer-http-train-'))
  const db = openDatabase(join(tmp, 'test.sqlite'))
  const script = join(tmp, 'fake_train.js')
  writeFileSync(script, FAKE_TRAIN)
  mkdirSync(join(tmp, 'logs'), { recursive: true })
  mkdirSync(join(tmp, 'training', 'style-v1', 'img'), { recursive: true })
  writeFileSync(join(tmp, 'training', 'style-v1', 'img', 'a.jpg'), 'x')
  writeFileSync(join(tmp, 'training', 'style-v1', 'img', 'a.txt'), 'tag')
  mkdirSync(join(tmp, 'models', 'checkpoints'), { recursive: true })
  writeFileSync(join(tmp, 'models', 'checkpoints', 'pd.safetensors'), 'm')
  trainer = {
    db,
    roots: buildRoots({
      models: join(tmp, 'models'),
      training: join(tmp, 'training'),
    }),
    controllers: new Map(),
    runs: new Map(),
    trainRuns: new Map(),
    train: {
      sdScriptsRoot: tmp,
      logsDir: join(tmp, 'logs'),
      spawnOverride: { executable: process.execPath, args: [script, '0', '40'] },
    },
    now: () => new Date(),
  }
  app = createApp(trainer)
})

afterEach(async () => {
  for (const [, run] of trainer.trainRuns ?? []) await run.promise.catch(() => {})
  trainer.db.close()
})

const CREATE_BODY = JSON.stringify({
  name: 'style-v1',
  datasetRoot: 'training',
  datasetPath: 'style-v1/img',
  baseModel: 'checkpoints/pd.safetensors',
})

test('POST /train/jobs creates, GET lists, GET :id reads', async () => {
  const created = await app.request('http://x/train/jobs', {
    method: 'POST',
    body: CREATE_BODY,
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(created.status, 201)
  const { job } = (await created.json()) as { job: { id: string; status: string } }
  assert.ok(job.id)

  const list = await app.request('http://x/train/jobs')
  const { jobs } = (await list.json()) as { jobs: { id: string }[] }
  assert.equal(jobs.length, 1)

  const one = await app.request(`http://x/train/jobs/${job.id}`)
  assert.equal(one.status, 200)
  const oneJson = (await one.json()) as { status: string; params: { name: string } }
  assert.equal(oneJson.params.name, 'style-v1')

  // 等完成再拉一次终态
  for (let i = 0; i < 200; i += 1) {
    const check = await app.request(`http://x/train/jobs/${job.id}`)
    const json = (await check.json()) as { status: string }
    if (json.status === 'completed') return
    await new Promise((ok) => setTimeout(ok, 25))
  }
  assert.fail('job did not complete in time')
})

test('POST /train/jobs validates fields', async () => {
  const cases: [string, string][] = [
    ['unknown field', JSON.stringify({ ...JSON.parse(CREATE_BODY), foo: 1 })],
    ['missing name', JSON.stringify({ datasetRoot: 'training', datasetPath: 'style-v1/img', baseModel: 'm' })],
    ['bad name', JSON.stringify({ ...JSON.parse(CREATE_BODY), name: '../x' })],
    ['missing datasetPath', JSON.stringify({ name: 'a', datasetRoot: 'training', baseModel: 'm' })],
  ]
  for (const [label, body] of cases) {
    const response = await app.request('http://x/train/jobs', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    })
    assert.ok(response.status >= 400, `should reject: ${label}`)
  }
})

test('POST /train/jobs 409 when another job is running', async () => {
  // 长跑 job
  trainer.train!.spawnOverride = {
    executable: process.execPath,
    args: [join(tmp, 'fake_train.js'), '0', '30000'],
  }
  const first = await app.request('http://x/train/jobs', {
    method: 'POST',
    body: CREATE_BODY,
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(first.status, 201)
  const { job } = (await first.json()) as { job: { id: string } }

  const second = await app.request('http://x/train/jobs', {
    method: 'POST',
    body: CREATE_BODY,
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(second.status, 409)

  // 取消清场
  const cancel = await app.request(`http://x/train/jobs/${job.id}`, { method: 'DELETE' })
  assert.equal(cancel.status, 200)
  const { job: cancelled } = (await cancel.json()) as { job: { status: string } }
  assert.equal(cancelled.status, 'cancelled')
})

test('log endpoint streams training log text', async () => {
  const created = await app.request('http://x/train/jobs', {
    method: 'POST',
    body: CREATE_BODY,
    headers: { 'content-type': 'application/json' },
  })
  const { job } = (await created.json()) as { job: { id: string } }
  const log = await app.request(`http://x/train/jobs/${job.id}/log`)
  assert.equal(log.status, 200)
  const text = await log.text()
  assert.match(text, /\[trainer\] spawn/)

  const missing = await app.request('http://x/train/jobs/nope/log')
  assert.equal(missing.status, 404)
})

test('/train/jobs without train config reports unconfigured', async () => {
  const original = trainer.train
  trainer.train = undefined
  const response = await app.request('http://x/train/jobs', {
    method: 'POST',
    body: CREATE_BODY,
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(response.status, 400)
  const json = (await response.json()) as { error: string }
  assert.match(json.error, /not configured/)
  trainer.train = original
})
