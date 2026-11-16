import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { openDatabase } from '../db.ts'
import { buildRoots } from '../roots.ts'
import type { Trainer } from '../download/manager.ts'
import {
  cancelTrainJob,
  createTrainJob,
  listTrainJobs,
  recoverTrainJobs,
  readTrainLog,
  type TrainConfig,
} from './manager.ts'

let trainer: Trainer
let tmp: string
let script: string

// 假训练脚本：node fake_train.js <sleepMs> <exitCode> [loop]
// loop 模式下每 50ms 打一行日志，用来验证日志落盘；SIGTERM 杀树后 close 带 SIGTERM。
const FAKE_TRAIN = `
const mode = process.argv[4]
const exitCode = Number(process.argv[3] ?? 0)
if (mode === 'loop') {
  const timer = setInterval(() => { console.log('step 1/3000'); }, 50)
  process.on('SIGTERM', () => { clearInterval(timer); process.exit(143) })
} else {
  setTimeout(() => process.exit(exitCode), Number(process.argv[2] ?? 100))
}
`

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'trainer-train-'))
  const db = openDatabase(join(tmp, 'test.sqlite'))
  script = join(tmp, 'fake_train.js')
  writeFileSync(script, FAKE_TRAIN)
  mkdirSync(join(tmp, 'logs'), { recursive: true })
  mkdirSync(join(tmp, 'training', 'style-v1', 'img'), { recursive: true })
  writeFileSync(join(tmp, 'training', 'style-v1', 'img', 'a.jpg'), 'x')
  writeFileSync(join(tmp, 'training', 'style-v1', 'img', 'a.txt'), 'tag')
  mkdirSync(join(tmp, 'models', 'checkpoints'), { recursive: true })
  writeFileSync(join(tmp, 'models', 'checkpoints', 'pd.safetensors'), 'm')
  const config: TrainConfig = {
    sdScriptsRoot: tmp,
    logsDir: join(tmp, 'logs'),
    spawnOverride: {
      executable: process.execPath,
      args: [script, '50', '0'],
    },
  }
  trainer = {
    db,
    roots: buildRoots({
      models: join(tmp, 'models'),
      training: join(tmp, 'training'),
    }),
    controllers: new Map(),
    runs: new Map(),
    trainRuns: new Map(),
    train: config,
    now: () => new Date(),
  }
})

afterEach(async () => {
  // 兜底：测试体中途断言失败会留下没人杀的 loop 子进程，先 cancel（杀树）再等落库
  const active = [...listTrainJobs(trainer.db, 'running'), ...listTrainJobs(trainer.db, 'pending')]
  for (const job of active) await cancelTrainJob(trainer, job.id).catch(() => {})
  for (const [, run] of trainer.trainRuns ?? []) await run.promise.catch(() => {})
  trainer.db.close()
})

async function waitUntil(id: string, status: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now()
  for (;;) {
    const row = trainer.db
      .prepare('SELECT status FROM train_jobs WHERE id = ?')
      .get(id) as { status: string } | undefined
    if (row?.status === status) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting ${status}, got ${row?.status ?? 'gone'}`)
    }
    await new Promise((ok) => setTimeout(ok, 25))
  }
}

function rowOf(id: string): Record<string, unknown> {
  return trainer.db
    .prepare('SELECT * FROM train_jobs WHERE id = ?')
    .get(id) as unknown as Record<string, unknown>
}

test('train job completes and writes tomls + log', async () => {
  const row = createTrainJob(trainer, {
    name: 'style-v1',
    datasetRoot: 'training',
    datasetPath: 'style-v1/img',
    baseModel: 'checkpoints/pd.safetensors',
  })
// start() 同步翻 running，所以 createTrainJob 返回时已是 running（pending 只是库里的过渡态）
  assert.equal(row.status, 'running')
  await waitUntil(row.id, 'completed')

  const done = rowOf(row.id)
  assert.equal(done.exit_code, 0)
  // TOML 落盘
  assert.match(String(done.dataset_toml), /config[\\/]dataset\.toml$/)
  assert.match(String(done.train_toml), /config[\\/]train\.toml$/)
  // 日志落盘（fake 脚本 spawn 行 + closed 行）
  const log = readTrainLog(trainer.train, row.id)
  assert.match(log, /\[trainer\] spawn/)
  assert.match(log, /\[trainer\] closed code=0/)
})

test('nonzero exit lands failed with exit code', async () => {
  trainer.train!.spawnOverride = {
    executable: process.execPath,
    args: [script, '30', '7'],
  }
  const row = createTrainJob(trainer, {
    name: 'style-v1',
    datasetRoot: 'training',
    datasetPath: 'style-v1/img',
    baseModel: 'checkpoints/pd.safetensors',
  })
  await waitUntil(row.id, 'failed')
  const failed = rowOf(row.id)
  assert.equal(failed.exit_code, 7)
  assert.match(String(failed.error), /code 7/)
})

test('cancel kills the child process tree', async () => {
  trainer.train!.spawnOverride = {
    executable: process.execPath,
    args: [script, '0', '0', 'loop'],
  }
  const row = createTrainJob(trainer, {
    name: 'style-v1',
    datasetRoot: 'training',
    datasetPath: 'style-v1/img',
    baseModel: 'checkpoints/pd.safetensors',
  })
  await waitUntil(row.id, 'running')
  const cancelled = await cancelTrainJob(trainer, row.id)
  assert.equal(cancelled.status, 'cancelled')
})

test('single running job enforced', async () => {
  trainer.train!.spawnOverride = {
    executable: process.execPath,
    args: [script, '0', '0', 'loop'],
  }
  createTrainJob(trainer, {
    name: 'style-v1',
    datasetRoot: 'training',
    datasetPath: 'style-v1/img',
    baseModel: 'checkpoints/pd.safetensors',
  })
  assert.throws(
    () =>
      createTrainJob(trainer, {
        name: 'style-v2',
        datasetRoot: 'training',
        datasetPath: 'style-v1/img',
        baseModel: 'checkpoints/pd.safetensors',
      }),
    /single job only/,
  )
  // 清场
  const running = listTrainJobs(trainer.db, 'running')
  await cancelTrainJob(trainer, running[0].id)
})

test('rejects missing model, missing dataset, empty dataset', async () => {
  const base = {
    name: 'style-v1',
    datasetRoot: 'training',
    datasetPath: 'style-v1/img',
    baseModel: 'checkpoints/nope.safetensors',
  }
  assert.throws(() => createTrainJob(trainer, base), /base model not found/)
  assert.throws(
    () => createTrainJob(trainer, { ...base, baseModel: 'checkpoints/pd.safetensors', datasetPath: 'nope/img' }),
    /dataset directory not found/,
  )
  mkdirSync(join(tmp, 'training', 'empty', 'img'), { recursive: true })
  assert.throws(
    () =>
      createTrainJob(trainer, {
        ...base,
        name: 'emptyset',
        datasetPath: 'empty/img',
        baseModel: 'checkpoints/pd.safetensors',
      }),
    /has no images/,
  )
})

test('recoverTrainJobs marks running/pending as failed', () => {
  trainer.db
    .prepare(
      `INSERT INTO train_jobs (id, name, status, params, created_at)
       VALUES ('j1', 'style-v1', 'running', '{}', '2026-01-01')`,
    )
    .run()
  recoverTrainJobs(trainer)
  const row = trainer.db
    .prepare('SELECT status, error FROM train_jobs WHERE id = ?')
    .get('j1') as { status: string; error: string }
  assert.equal(row.status, 'failed')
  assert.match(row.error, /interrupted by trainer restart/)
})

test('readTrainLog 404s for unknown log', () => {
  assert.throws(() => readTrainLog(trainer.train, 'nope'), /log not found/)
})
