import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
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
  isProcessAlive,
  listTrainJobs,
  pauseTrainJob,
  recoverTrainJobs,
  readTrainLog,
  resumeTrainJob,
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
  // pid 落库：trainer 重启后靠它判断训练进程还活不活
  assert.ok(Number(done.pid) > 0)
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
  // 等子进程先吐几行：stdio 直指日志文件，说明输出不经过 node 管道
  const logFile = join(tmp, 'logs', `${row.id}.log`)
  const started = Date.now()
  while (Date.now() - started < 3000) {
    if (readFileSync(logFile, 'utf8').includes('step 1/3000')) break
    await new Promise((ok) => setTimeout(ok, 30))
  }
  const cancelled = await cancelTrainJob(trainer, row.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.match(readTrainLog(trainer.train, row.id), /step 1\/3000/)
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

test('readTrainLog 只返回尾巴', async () => {
  const row = createTrainJob(trainer, {
    name: 'style-v1',
    datasetRoot: 'training',
    datasetPath: 'style-v1/img',
    baseModel: 'checkpoints/pd.safetensors',
  })
  await waitUntil(row.id, 'completed')
  const full = readTrainLog(trainer.train, row.id)
  const tail = readTrainLog(trainer.train, row.id, 24)
  assert.equal(tail.length, 24)
  assert.ok(full.endsWith(tail))
})

test('pause/resume 挂起进程树但状态仍是 running', async () => {
  trainer.train!.spawnOverride = {
    executable: process.execPath,
    args: [script, '0', '0', 'loop'],
  }
  const calls: string[] = []
  let suspendedPid = 0
  trainer.train!.suspend = async (pid) => {
    calls.push(`pause:${pid}`)
    suspendedPid = pid
  }
  trainer.train!.resume = async (pid) => {
    calls.push(`resume:${pid}`)
  }

  const row = createTrainJob(trainer, {
    name: 'style-v1',
    datasetRoot: 'training',
    datasetPath: 'style-v1/img',
    baseModel: 'checkpoints/pd.safetensors',
  })
  await waitUntil(row.id, 'running')

  const paused = await pauseTrainJob(trainer, row.id)
  assert.equal(paused.status, 'running')
  assert.ok(paused.paused_at)
  assert.equal(calls[0], `pause:${suspendedPid}`)
  assert.ok(suspendedPid > 0)
  // 暂停中仍占着单任务锁
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
  // 重复暂停幂等，不再调挂起
  await pauseTrainJob(trainer, row.id)
  assert.equal(calls.filter((c) => c.startsWith('pause:')).length, 1)

  const resumed = await resumeTrainJob(trainer, row.id)
  assert.equal(resumed.paused_at, null)
  assert.equal(calls.at(-1), `resume:${suspendedPid}`)

  await cancelTrainJob(trainer, row.id)
})

test('pause 拒绝非 running 任务', async () => {
  trainer.db
    .prepare(
      `INSERT INTO train_jobs (id, name, status, params, created_at)
       VALUES ('j2', 'style-v1', 'completed', '{}', '2026-01-01')`,
    )
    .run()
  await assert.rejects(() => pauseTrainJob(trainer, 'j2'), /cannot pause a completed job/)
  await assert.rejects(() => pauseTrainJob(trainer, 'nope'), /train job not found/)
})

// ---------- 重启不杀训练：pid 存活则 re-attach ----------

// 模拟「trainer 重启前 spawn 的、现在还活着的」训练进程
function spawnForeign(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
}

function insertRunning(id: string, pid: number | null, logText = ''): void {
  trainer.db
    .prepare(
      `INSERT INTO train_jobs (id, name, status, params, created_at, started_at, pid)
       VALUES (?, 'style-v1', 'running', '{}', '2026-01-01', '2026-01-01', ?)`,
    )
    .run(id, pid)
  if (logText) writeFileSync(join(tmp, 'logs', `${id}.log`), logText)
}

async function waitStatus(id: string, status: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  for (;;) {
    const row = trainer.db
      .prepare('SELECT status FROM train_jobs WHERE id = ?')
      .get(id) as { status: string } | undefined
    if (row?.status === status) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting ${status}, got ${row?.status ?? 'gone'}`)
    }
    await new Promise((ok) => setTimeout(ok, 20))
  }
}

test('pid 存活的 running 任务在重启后保留并 re-attach 收尾', async () => {
  trainer.train!.watchPollMs = 20
  const child = spawnForeign()
  try {
    insertRunning(
      'j3',
      child.pid!,
      'steps:  50%|███       | 1500/3000 [10:00<10:00, 0.4s/it]\n' +
        'steps: 100%|██████████| 3000/3000 [20:00<00:00, 0.4s/it]\n',
    )
    recoverTrainJobs(trainer)
    // 进程还活着：不标 failed，也不丢单任务锁
    assert.equal(listTrainJobs(trainer.db, 'running').length, 1)
    await new Promise((ok) => setTimeout(ok, 60))
    assert.equal(rowOf('j3').status, 'running')

    child.kill()
    await waitStatus('j3', 'completed')
    const done = rowOf('j3')
    assert.equal(done.exit_code, null)
    assert.match(readTrainLog(trainer.train, 'j3'), /re-attach: process exited after 3000\/3000/)
  } finally {
    child.kill()
  }
})

test('re-attach 后进程没跑完就消失 → failed 并说明停在哪', async () => {
  trainer.train!.watchPollMs = 20
  const child = spawnForeign()
  try {
    insertRunning('j4', child.pid!, 'steps:  17%|█         | 100/3000 [1:00<29:00, 0.6s/it]\n')
    recoverTrainJobs(trainer)
    child.kill()
    await waitStatus('j4', 'failed')
    const row = rowOf('j4')
    assert.match(String(row.error), /停在 100\/3000/)
    assert.match(String(row.error), /退出码未知/)
  } finally {
    child.kill()
  }
})

test('re-attach 的任务能被取消（按库里的 pid 杀树）', async () => {
  const child = spawnForeign()
  try {
    insertRunning('j5', child.pid!)
    recoverTrainJobs(trainer)
    const cancelled = await cancelTrainJob(trainer, 'j5')
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(isProcessAlive(child.pid!), false)
  } finally {
    child.kill()
  }
})

test('re-attach 的任务能暂停/恢复（pid 来自库里）', async () => {
  const child = spawnForeign()
  const calls: string[] = []
  trainer.train!.suspend = async (pid) => {
    calls.push(`pause:${pid}`)
  }
  trainer.train!.resume = async (pid) => {
    calls.push(`resume:${pid}`)
  }
  try {
    insertRunning('j6', child.pid!)
    recoverTrainJobs(trainer)
    const paused = await pauseTrainJob(trainer, 'j6')
    assert.ok(paused.paused_at)
    const resumed = await resumeTrainJob(trainer, 'j6')
    assert.equal(resumed.paused_at, null)
    assert.deepEqual(calls, [`pause:${child.pid}`, `resume:${child.pid}`])
  } finally {
    child.kill()
    await waitStatus('j6', 'running').catch(() => {})
    await cancelTrainJob(trainer, 'j6').catch(() => {})
  }
})

test('pid 已消失的 running 任务仍按老规矩标 failed', () => {
  // 取一个必然不存在的 pid：先起再杀，避免撞到别的进程
  insertRunning('j7', 999_999)
  recoverTrainJobs(trainer)
  const row = rowOf('j7')
  assert.equal(row.status, 'failed')
  assert.match(String(row.error), /interrupted by trainer restart/)
})
