import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { RunnerError } from '../errors.ts'

export interface RunRecord {
  id: string
  pluginId: string
  scene: string | null
  variables: Record<string, unknown>
  status: 'running' | 'ok' | 'error'
  createdAt: string
  finishedAt?: string
  log?: string
  error?: string
  outputDir: string
}

function runsRoot(dataDir: string): string {
  return join(dataDir, 'runs')
}

function runDir(dataDir: string, id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new RunnerError(`invalid run id: ${id}`, 400)
  }
  const base = resolve(runsRoot(dataDir))
  const target = resolve(base, id)
  if (target !== base && !target.startsWith(base + sep)) {
    throw new RunnerError(`invalid run id: ${id}`, 400)
  }
  return target
}

function write(dir: string, record: RunRecord): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`)
}

export function startRun(
  dataDir: string,
  input: {
    pluginId: string
    scene: string | null
    variables: Record<string, unknown>
    repoRoot: string
  },
): RunRecord {
  const id = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(4).toString('hex')}`
  const dir = runDir(dataDir, id)
  const record: RunRecord = {
    id,
    pluginId: input.pluginId,
    scene: input.scene,
    variables: input.variables,
    status: 'running',
    createdAt: new Date().toISOString(),
    outputDir: relative(input.repoRoot, join(dir, 'output')),
  }
  write(dir, record)
  mkdirSync(join(dir, 'output'), { recursive: true })
  return record
}

export function finishRun(
  dataDir: string,
  id: string,
  patch: Partial<Pick<RunRecord, 'status' | 'log' | 'error'>>,
): RunRecord {
  const dir = runDir(dataDir, id)
  const path = join(dir, 'run.json')
  if (!existsSync(path)) throw new RunnerError(`run not found: ${id}`, 404)
  const current = JSON.parse(readFileSync(path, 'utf8')) as RunRecord
  const next: RunRecord = {
    ...current,
    ...patch,
    finishedAt: new Date().toISOString(),
  }
  write(dir, next)
  return next
}

export function getRun(dataDir: string, id: string): RunRecord {
  const path = join(runDir(dataDir, id), 'run.json')
  if (!existsSync(path)) throw new RunnerError(`run not found: ${id}`, 404)
  return JSON.parse(readFileSync(path, 'utf8')) as RunRecord
}

export function listRuns(dataDir: string, limit = 30): RunRecord[] {
  const root = runsRoot(dataDir)
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => existsSync(join(root, name, 'run.json')))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((name) => getRun(dataDir, name))
}
