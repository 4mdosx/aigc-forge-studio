import { spawn, type ChildProcess } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { DatabaseSync } from 'node:sqlite'

import { TrainerError } from '../errors.ts'
import type { RootRegistry } from '../roots.ts'
import { resumeProcessTree, suspendProcessTree } from './pause.ts'
import {
  buildDatasetToml,
  buildTrainToml,
  jobPaths,
  resolveParams,
  type JobPaths,
  type ResolvedParams,
  type TrainParamsInput,
} from './toml.ts'

// 训练 job 管理器。与 download 管理器同一套纪律：
//   POST 建任务即刻返回 pending，单实例单 running，进程退出落终态。
//   区别是这里跑的是 sd-scripts 子进程，产物由 save_every_n_epochs 写进 output_dir。
//
// 重启语义（2026-11-21 改）：子进程 stdout/stderr 直接重定向到 <logsDir>/<id>.log，
//   不再走 node 管道 —— trainer 进程死了训练照样跑、日志照样写。pid 落库，
//   启动时 pid 还活着就 re-attach 轮询（而非一刀切标 failed），进程没了才落终态。

export interface TrainConfig {
  /** sd-scripts 仓库根（含 train_network.py 与 venv） */
  sdScriptsRoot: string
  numCpuThreads?: number
  /** 训练日志目录（绝对路径；main.ts 从相对缺省换算） */
  logsDir?: string
  /** 测试注入：跳过 accelerate/python 组装，直接给定可执行与参数 */
  spawnOverride?: { executable: string; args: string[] }
  /** 测试注入：进程树挂起/恢复（缺省走 pause.ts） */
  suspend?: (pid: number) => Promise<void>
  resume?: (pid: number) => Promise<void>
  /** re-attach 轮询间隔（缺省 5s；测试里调小） */
  watchPollMs?: number
}

export interface TrainRun {
  child: ChildProcess
  promise: Promise<void>
}

export type TrainStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface TrainJobRow {
  id: string
  name: string
  status: TrainStatus
  params: string
  dataset_toml: string | null
  train_toml: string | null
  output_dir: string | null
  exit_code: number | null
  error: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  paused_at?: string | null
  pid?: number | null
}

export interface TrainJobJson {
  id: string
  name: string
  status: TrainStatus
  params: Record<string, unknown>
  datasetToml: string | null
  trainToml: string | null
  outputDir: string | null
  exitCode: number | null
  error: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  pausedAt: string | null
  /** 子进程 pid（re-attach 与 nvidia-smi 逐进程对照用；终态仍保留最后值） */
  pid: number | null
}

export function trainJobJson(row: TrainJobRow): TrainJobJson {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    params: JSON.parse(row.params) as Record<string, unknown>,
    datasetToml: row.dataset_toml,
    trainToml: row.train_toml,
    outputDir: row.output_dir,
    exitCode: row.exit_code,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    // 终态不留暂停痕迹：paused_at 只在 running 时有意义
    pausedAt: row.status === 'running' ? (row.paused_at ?? null) : null,
    pid: row.pid ?? null,
  }
}

interface TrainerConfig {
  db: DatabaseSync
  roots: RootRegistry
  train?: TrainConfig
  trainRuns?: Map<string, TrainRun>
  now: () => Date
}

// trainRuns 惰性初始化：Trainer 字面量（既有测试）可以不带这个字段
export function runsOf(trainer: TrainerConfig): Map<string, TrainRun> {
  trainer.trainRuns ??= new Map()
  return trainer.trainRuns
}

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp']

function requireConfig(trainer: TrainerConfig): TrainConfig {
  if (!trainer.train) {
    throw new TrainerError(
      'training stack not configured (trainer.train in config.json)',
    )
  }
  return trainer.train
}

function logPath(config: TrainConfig, id: string): string {
  return join(config.logsDir ?? join('data', 'train'), `${id}.log`)
}

function appendLog(config: TrainConfig, id: string, text: string): void {
  try {
    appendFileSync(logPath(config, id), text)
  } catch {
    // 日志失败不拖垮训练进程管理
  }
}

function rowOf(db: DatabaseSync, id: string): TrainJobRow | undefined {
  return db
    .prepare('SELECT * FROM train_jobs WHERE id = ?')
    .get(id) as TrainJobRow | undefined
}

export function listTrainJobs(db: DatabaseSync, status?: string): TrainJobRow[] {
  if (status) {
    return db
      .prepare('SELECT * FROM train_jobs WHERE status = ? ORDER BY created_at')
      .all(status) as unknown as TrainJobRow[]
  }
  return db
    .prepare('SELECT * FROM train_jobs ORDER BY created_at')
    .all() as unknown as TrainJobRow[]
}

// 生产环境的子进程命令：venv python 直接拉 accelerate，免 PATH/venv 激活依赖。
// mixed_precision 等在此显式给足，训练机无需预先跑 accelerate config。
export function buildSpawnPlan(
  config: TrainConfig,
  paths: JobPaths,
  sdxl = true,
): { executable: string; args: string[] } {
  if (config.spawnOverride) return config.spawnOverride
  const python = join(config.sdScriptsRoot, 'venv', 'Scripts', 'python.exe')
  // sd-scripts v0.12 的 train_network.py 是 SD1/2 专用；SDXL 必须走
  // sdxl_train_network.py（继承基类，is_sdxl=True）—— TOML 里没有 --sdxl 这种开关（实测坑）。
  const script = sdxl ? 'sdxl_train_network.py' : 'train_network.py'
  return {
    executable: python,
    args: [
      '-m', 'accelerate.commands.launch',
      '--num_processes', '1',
      '--num_machines', '1',
      '--mixed_precision', 'bf16',
      '--dynamo_backend', 'no',
      '--num_cpu_threads_per_process', String(config.numCpuThreads ?? 8),
      script,
      '--config_file', join(paths.configDir, 'train.toml'),
      '--dataset_config', join(paths.configDir, 'dataset.toml'),
    ],
  }
}

export function createTrainJob(
  trainer: TrainerConfig,
  input: TrainParamsInput,
): TrainJobRow {
  const config = requireConfig(trainer)
  const params = resolveParams(input)

  const trainingRoot = trainer.roots[input.datasetRoot]
  if (!trainingRoot) {
    throw new TrainerError(`unknown root: ${input.datasetRoot}`, 404)
  }
  const modelsRoot = trainer.roots.models
  if (!modelsRoot) throw new TrainerError('models root not configured', 500)

  const paths = jobPaths({ training: trainingRoot, models: modelsRoot }, params)

  // 前置校验：底模与数据集都得真实存在，别放一个注定失败的异步任务
  if (!existsSync(paths.modelPath)) {
    throw new TrainerError(`base model not found: ${paths.modelPath}`, 404)
  }
  if (!existsSync(paths.datasetDir)) {
    throw new TrainerError(`dataset directory not found: ${paths.datasetDir}`, 404)
  }
  const images = readdirSync(paths.datasetDir).filter((name) => {
    const dot = name.lastIndexOf('.')
    return dot >= 0 && IMAGE_EXTS.includes(name.slice(dot).toLowerCase())
  })
  if (images.length === 0) {
    throw new TrainerError(`dataset directory has no images: ${paths.datasetDir}`, 400)
  }

  const running = listTrainJobs(trainer.db, 'running')
  if (running.length > 0) {
    throw new TrainerError(
      `another training job is running (${running[0].name}); single job only`,
      409,
    )
  }

  // 落配置：training/<name>/config/{dataset,train}.toml (+ prompts.txt)
  mkdirSync(paths.configDir, { recursive: true })
  mkdirSync(paths.outputDir, { recursive: true })
  const datasetToml = join(paths.configDir, 'dataset.toml')
  const trainToml = join(paths.configDir, 'train.toml')
  writeFileSync(datasetToml, buildDatasetToml(params, paths))
  writeFileSync(trainToml, buildTrainToml(params, paths))
  if (params.samplePrompts) {
    writeFileSync(join(paths.configDir, 'prompts.txt'), params.samplePrompts)
  }

  const id = randomUUID()
  trainer.db
    .prepare(
      `INSERT INTO train_jobs (id, name, status, params, dataset_toml, train_toml, output_dir, created_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      params.name,
      JSON.stringify(params),
      datasetToml,
      trainToml,
      paths.outputDir,
      trainer.now().toISOString(),
    )

  const run = start(trainer, id, config, paths, params.sdxl)
  runsOf(trainer).set(id, run)
  const row = rowOf(trainer.db, id)
  if (!row) throw new TrainerError('train job vanished', 500)
  return row
}

// 同步 spawn、立即返回 run；close/error 在 promise 内落库
function start(
  trainer: TrainerConfig,
  id: string,
  config: TrainConfig,
  paths: JobPaths,
  sdxl = true,
): TrainRun {
  const plan = buildSpawnPlan(config, paths, sdxl)
  trainer.db
    .prepare(
      `UPDATE train_jobs SET status = 'running', started_at = ?, error = NULL
       WHERE id = ? AND status = 'pending'`,
    )
    .run(trainer.now().toISOString(), id)
  appendLog(config, id, `[trainer] spawn ${plan.executable} ${plan.args.join(' ')}\n`)

  // 日志直接由子进程写文件：trainer 挂掉时管道会断（python 的 tqdm 写已关闭的
  // stdout 直接抛错），换成 fd 重定向后训练与日志都不再依赖本进程存活。
  const logFile = logPath(config, id)
  mkdirSync(dirname(logFile), { recursive: true })
  const logFd = openSync(logFile, 'a')
  const child = spawn(plan.executable, plan.args, {
    cwd: config.sdScriptsRoot,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    stdio: ['ignore', logFd, logFd],
    // posix 下脱离进程组好整树杀；Windows 用 taskkill /T
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
  // 子进程已继承句柄，父进程这份可以关掉（Windows 上亦然）
  closeSync(logFd)
  if (child.pid) {
    trainer.db
      .prepare('UPDATE train_jobs SET pid = ? WHERE id = ?')
      .run(child.pid, id)
  }

  const promise = new Promise<void>((resolve) => {
    child.on('error', (err) => {
      appendLog(config, id, `[trainer] spawn error: ${err.message}\n`)
      trainer.db
        .prepare(
          `UPDATE train_jobs SET status = 'failed', error = ?, completed_at = ?
           WHERE id = ? AND status IN ('pending','running')`,
        )
        .run(err.message, trainer.now().toISOString(), id)
      resolve()
    })
    child.on('close', (code, signal) => {
      appendLog(config, id, `[trainer] closed code=${code} signal=${signal}\n`)
      const current = rowOf(trainer.db, id)
      if (current && current.status === 'running') {
        if (cancelledIds.has(id) || signal === 'SIGTERM') {
          trainer.db
            .prepare(
              `UPDATE train_jobs SET status = 'cancelled', error = 'cancelled by request', completed_at = ?
               WHERE id = ? AND status = 'running'`,
            )
            .run(trainer.now().toISOString(), id)
        } else if (code === 0) {
          trainer.db
            .prepare(
              `UPDATE train_jobs SET status = 'completed', exit_code = 0, error = NULL, completed_at = ?
               WHERE id = ? AND status = 'running'`,
            )
            .run(trainer.now().toISOString(), id)
        } else {
          const message = `sd-scripts exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`
          trainer.db
            .prepare(
              `UPDATE train_jobs SET status = 'failed', exit_code = ?, error = ?, completed_at = ?
               WHERE id = ? AND status = 'running'`,
            )
            .run(code, message, trainer.now().toISOString(), id)
        }
      }
      if (cancelledIds.has(id)) cancelledIds.delete(id)
      resolve()
    })
  })

  return { child, promise }
}

// 进程存活判断：Windows 上 process.kill(pid, 0) 走 OpenProcess，够用。
// EPERM 说明进程在但不是我们的，也算活。
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// 杀整棵进程树（Windows: taskkill /T /F；posix: 进程组 SIGTERM）
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // 已经没了
    }
  }
}

async function waitUntilDead(pid: number, timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true
    await new Promise((ok) => setTimeout(ok, 100))
  }
  return !isProcessAlive(pid)
}

// tqdm: `steps:  21%|██        | 682/3280 [1:35:07<6:02:23, 8.37s/it, avr_loss=...]`
const PROGRESS_RE = /steps:\s*\d+%\|[^|]*\|\s*(\d+)\/(\d+)/g

function lastProgress(text: string): { step: number; total: number } | null {
  let last: { step: number; total: number } | null = null
  for (const match of text.matchAll(PROGRESS_RE)) {
    last = { step: Number(match[1]), total: Number(match[2]) }
  }
  return last
}

const orphanTimers = new Map<string, ReturnType<typeof setInterval>>()

// re-attach：进程不是我们 spawn 的，拿不到 exit code，只能等 pid 消失后按日志收尾
function watchOrphan(trainer: TrainerConfig, id: string, pid: number): void {
  if (orphanTimers.has(id)) return
  const poll = trainer.train?.watchPollMs ?? 5000
  const timer = setInterval(() => {
    const row = rowOf(trainer.db, id)
    if (!row || row.status !== 'running') {
      stop()
      return
    }
    if (isProcessAlive(pid)) return
    stop()
    finalizeOrphan(trainer, id)
  }, poll)
  timer.unref()
  orphanTimers.set(id, timer)

  function stop(): void {
    clearInterval(timer)
    orphanTimers.delete(id)
  }
}

function finalizeOrphan(trainer: TrainerConfig, id: string): void {
  const config = trainer.train
  let tail = ''
  if (config) {
    try {
      tail = readTrainLog(config, id, 400_000)
    } catch {
      tail = ''
    }
  }
  const progress = lastProgress(tail)
  const at = trainer.now().toISOString()
  if (progress && progress.step >= progress.total) {
    trainer.db
      .prepare(
        `UPDATE train_jobs SET status = 'completed', exit_code = NULL, error = NULL, completed_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(at, id)
    if (config) {
      appendLog(
        config,
        id,
        `\n[trainer] re-attach: process exited after ${progress.step}/${progress.total}, 按日志判定完成\n`,
      )
    }
    return
  }
  const detail = progress ? `停在 ${progress.step}/${progress.total}` : '日志里没有进度行'
  trainer.db
    .prepare(
      `UPDATE train_jobs SET status = 'failed', error = ?, completed_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(`sd-scripts 在 trainer 未 attach 期间退出（${detail}，退出码未知）`, at, id)
  if (config) appendLog(config, id, `\n[trainer] re-attach: process gone (${detail})\n`)
}

// 重启恢复：pid 还活着的 running 保留并 re-attach，其余（含 pending）标 failed
export function recoverTrainJobs(trainer: TrainerConfig): void {
  const rows = [
    ...listTrainJobs(trainer.db, 'running'),
    ...listTrainJobs(trainer.db, 'pending'),
  ]
  for (const row of rows) {
    if (row.status === 'running' && row.pid && isProcessAlive(row.pid)) {
      if (trainer.train) {
        appendLog(
          trainer.train,
          row.id,
          `\n[trainer] re-attach pid=${row.pid}（trainer 重启，训练进程仍在跑）\n`,
        )
      }
      watchOrphan(trainer, row.id, row.pid)
      continue
    }
    trainer.db
      .prepare(
        `UPDATE train_jobs
         SET status = 'failed', error = 'interrupted by trainer restart', completed_at = ?
         WHERE id = ? AND status IN ('pending','running')`,
      )
      .run(trainer.now().toISOString(), row.id)
  }
}

// 显式取消登记：Windows taskkill /F 杀出的 close 事件是 code=1/signal=null，
// 不能靠 signal 辨别取消，落库前先查这个集合。
const cancelledIds = new Set<string>()

function markCancelled(trainer: TrainerConfig, id: string): void {
  trainer.db
    .prepare(
      `UPDATE train_jobs SET status = 'cancelled', error = 'cancelled by request', completed_at = ?
       WHERE id = ? AND status IN ('pending','running')`,
    )
    .run(trainer.now().toISOString(), id)
}

// 取消：杀进程树（Windows: taskkill /T /F；posix: 进程组 SIGTERM），等状态落库
export async function cancelTrainJob(
  trainer: TrainerConfig,
  id: string,
): Promise<TrainJobRow> {
  const row = rowOf(trainer.db, id)
  if (!row) throw new TrainerError('train job not found', 404)
  if (row.status === 'completed' || row.status === 'cancelled') return row

  const run = runsOf(trainer).get(id)
  if (run?.child.pid) {
    cancelledIds.add(id)
    killTree(run.child.pid)
    await run.promise
  } else if (row.pid && isProcessAlive(row.pid)) {
    // re-attach 的任务：进程不是本进程 spawn 的，收不到 close，自己等死后落库
    killTree(row.pid)
    await waitUntilDead(row.pid)
    markCancelled(trainer, id)
  } else {
    // 无进程可杀（pending 一瞬或 spawn 失败）：直接落 cancelled
    markCancelled(trainer, id)
  }
  const next = rowOf(trainer.db, id)
  if (!next) throw new TrainerError('train job vanished', 500)
  return next
}

// 暂停/恢复：挂起整棵进程树，status 保持 running（单任务锁 continues to hold），
// 只有 paused_at 记录时间戳。恢复不重放任何状态，纯粹让线程继续跑。
async function setPaused(
  trainer: TrainerConfig,
  id: string,
  paused: boolean,
): Promise<TrainJobRow> {
  const row = rowOf(trainer.db, id)
  if (!row) throw new TrainerError('train job not found', 404)
  if (row.status !== 'running') {
    throw new TrainerError(`cannot ${paused ? 'pause' : 'resume'} a ${row.status} job`, 409)
  }
  const already = Boolean(row.paused_at)
  if (already === paused) return row

  const config = requireConfig(trainer)
  const run = runsOf(trainer).get(id)
  // re-attach 的任务没有 ChildProcess，只能靠库里 pid（活着才可用）
  const pid = run?.child.pid ?? (row.pid && isProcessAlive(row.pid) ? row.pid : 0)
  if (!pid) {
    throw new TrainerError(
      `training process is not attached (trainer restarted?); cannot ${paused ? 'pause' : 'resume'}`,
      409,
    )
  }
  const call = paused ? (config.suspend ?? suspendProcessTree) : (config.resume ?? resumeProcessTree)
  try {
    await call(pid)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new TrainerError(`${paused ? 'pause' : 'resume'} failed: ${message}`, 500)
  }

  trainer.db
    .prepare(`UPDATE train_jobs SET paused_at = ? WHERE id = ? AND status = 'running'`)
    .run(paused ? trainer.now().toISOString() : null, id)
  appendLog(
    config,
    id,
    `\n[trainer] ${paused ? 'paused' : 'resumed'} at ${trainer.now().toISOString()}\n`,
  )
  const next = rowOf(trainer.db, id)
  if (!next) throw new TrainerError('train job vanished', 500)
  return next
}

export async function pauseTrainJob(
  trainer: TrainerConfig,
  id: string,
): Promise<TrainJobRow> {
  return setPaused(trainer, id, true)
}

export async function resumeTrainJob(
  trainer: TrainerConfig,
  id: string,
): Promise<TrainJobRow> {
  return setPaused(trainer, id, false)
}

// tail 给的是字符数，用于前端只看进度尾巴（训练日志跑两小时能到几百 KB）
export function readTrainLog(
  config: TrainConfig | undefined,
  id: string,
  tail?: number,
): string {
  if (!config) throw new TrainerError('training stack not configured')
  const path = logPath(config, id)
  if (!existsSync(path)) throw new TrainerError('log not found', 404)
  const text = readFileSync(path, 'utf8')
  if (!tail || tail <= 0 || text.length <= tail) return text
  return text.slice(text.length - tail)
}
