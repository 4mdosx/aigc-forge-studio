import { spawn, type ChildProcess } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { DatabaseSync } from 'node:sqlite'

import { TrainerError } from '../errors.ts'
import type { RootRegistry } from '../roots.ts'
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
//   POST 建任务即刻返回 pending，单实例单 running，进程退出落终态，
//   重启恢复把 running 标 failed。区别是这里跑的是 sd-scripts 子进程，
//   日志逐行落 <logsDir>/<id>.log，产物由 save_every_n_epochs 写进 output_dir。

export interface TrainConfig {
  /** sd-scripts 仓库根（含 train_network.py 与 venv） */
  sdScriptsRoot: string
  numCpuThreads?: number
  /** 训练日志目录（绝对路径；main.ts 从相对缺省换算） */
  logsDir?: string
  /** 测试注入：跳过 accelerate/python 组装，直接给定可执行与参数 */
  spawnOverride?: { executable: string; args: string[] }
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

  const child = spawn(plan.executable, plan.args, {
    cwd: config.sdScriptsRoot,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // posix 下脱离进程组好整树杀；Windows 用 taskkill /T
    detached: process.platform !== 'win32',
    windowsHide: true,
  })

  const promise = new Promise<void>((resolve) => {
    child.stdout?.on('data', (chunk: Buffer) => appendLog(config, id, chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => appendLog(config, id, chunk.toString()))
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

// 重启恢复：进程没了，pending/running 标 failed
export function recoverTrainJobs(trainer: TrainerConfig): void {
  trainer.db
    .prepare(
      `UPDATE train_jobs
       SET status = 'failed', error = 'interrupted by trainer restart', completed_at = ?
       WHERE status IN ('pending','running')`,
    )
    .run(trainer.now().toISOString())
}

// 显式取消登记：Windows taskkill /F 杀出的 close 事件是 code=1/signal=null，
// 不能靠 signal 辨别取消，落库前先查这个集合。
const cancelledIds = new Set<string>()

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
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(run.child.pid), '/T', '/F'], {
        windowsHide: true,
      })
    } else {
      try {
        process.kill(-run.child.pid, 'SIGTERM')
      } catch {
        run.child.kill('SIGTERM')
      }
    }
    await run.promise
  } else {
    // 无进程可杀（pending 一瞬或 spawn 失败）：直接落 cancelled
    trainer.db
      .prepare(
        `UPDATE train_jobs SET status = 'cancelled', error = 'cancelled by request', completed_at = ?
         WHERE id = ? AND status IN ('pending','running')`,
      )
      .run(trainer.now().toISOString(), id)
  }
  const next = rowOf(trainer.db, id)
  if (!next) throw new TrainerError('train job vanished', 500)
  return next
}

export function readTrainLog(config: TrainConfig | undefined, id: string): string {
  if (!config) throw new TrainerError('training stack not configured')
  const path = logPath(config, id)
  if (!existsSync(path)) throw new TrainerError('log not found', 404)
  return readFileSync(path, 'utf8')
}
