#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { styleText } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  cancel,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  select,
  updateSettings,
} from '@clack/prompts'

const root = dirname(fileURLToPath(import.meta.url))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const webPort = 3000
const tags = {
  runner: ['bold', 'cyan'],
  web: ['bold', 'magenta'],
  critic: ['bold', 'yellow'],
}

const children = []
let stopping = false

if (!process.stdin.isTTY) {
  console.error('需要在终端里选择模式和服务')
  process.exit(1)
}

process.on('SIGINT', () => halt(0))
process.on('SIGTERM', () => halt(0))

await main()

async function main() {
  updateSettings({
    messages: {
      cancel: '已取消',
      error: '出错了',
    },
  })
  intro(styleText(['bgCyan', 'black'], ' AIGC '))
  log.info('方向键移动 · 空格勾选 · 回车确认')

  const mode = await select({
    message: '模式',
    options: [
      { value: 'dev', label: 'dev', hint: '热更新' },
      { value: 'deploy', label: 'deploy', hint: '先构建 web' },
    ],
    showInstructions: false,
  })
  if (isCancel(mode)) {
    cancel('已取消')
    process.exit(0)
  }

  const runner = runnerEndpoint()
  const critic = criticEndpoint()
  const selected = await chooseServices([
    {
      value: 'runner+web',
      label: serviceLabel('runner+web', `${browseHost(runner.host)}:${runner.port} · ${webPort}`),
    },
    {
      value: 'critic',
      label: serviceLabel('critic', `${critic.host}:${critic.port}`),
    },
  ])

  const ids = new Set(selected)
  const script = mode === 'dev' ? 'dev' : 'start'
  let runnerCwd = ''
  let webCwd = ''
  let python = ''
  try {
    if (ids.has('runner+web')) {
      runnerCwd = nodeApp('runner')
      webCwd = nodeApp('web')
    }
    if (ids.has('critic')) python = pythonBin()
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  if (ids.has('runner+web') && mode === 'deploy') {
    log.step('构建 web')
    try {
      await runOnce('web', npm, ['run', 'build'], webCwd)
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err))
      stop(1)
      return
    }
    log.success('web 构建完成')
  }

  const lines = []
  if (ids.has('runner+web')) {
    lines.push(`runner  http://${browseHost(runner.host)}:${runner.port}`)
    lines.push(`web     http://127.0.0.1:${webPort}`)
  }
  if (ids.has('critic')) {
    lines.push(`critic  http://${critic.host}:${critic.port}`)
  }
  note(lines.join('\n'), mode)
  outro('Ctrl+C 停止')

  if (ids.has('runner+web')) {
    launch('runner', npm, ['run', script], runnerCwd)
    launch('web', npm, ['run', script], webCwd)
  }
  if (ids.has('critic')) {
    launch('critic', python, [
      join(root, 'critic', 'server.py'),
      '--host', critic.host,
      '--port', String(critic.port),
    ], root)
  }
}

async function chooseServices(options) {
  for (;;) {
    const selected = await multiselect({
      message: '服务',
      required: false,
      showInstructions: false,
      options,
    })
    if (isCancel(selected)) {
      cancel('已取消')
      process.exit(0)
    }
    if (selected.length > 0) return selected
    log.warning('至少选一个')
  }
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
  } catch {
    return null
  }
}

function serviceLabel(name, detail) {
  return `${name.padEnd(12)}${detail}`
}

function browseHost(host) {
  if (host === '0.0.0.0' || host === '::' || host === '[::]') return '127.0.0.1'
  return host
}

function runnerEndpoint() {
  const runner = readConfig()?.runner
  const host = typeof runner?.host === 'string' && runner.host.trim() !== ''
    ? runner.host.trim()
    : '127.0.0.1'
  const port = Number.isInteger(runner?.port) && runner.port >= 1 && runner.port <= 65535
    ? runner.port
    : 8787
  return { host, port }
}

function nodeApp(name) {
  const cwd = join(root, name)
  if (!existsSync(join(cwd, 'node_modules'))) {
    throw new Error(`${name}: 先在 ${cwd} 执行 npm install`)
  }
  return cwd
}

function pythonBin() {
  const bin = process.platform === 'win32'
    ? join(root, '.venv', 'Scripts', 'python.exe')
    : join(root, '.venv', 'bin', 'python')
  if (!existsSync(bin)) {
    throw new Error('critic: 先在仓库根目录创建 .venv 并安装 critic/requirements.txt')
  }
  return bin
}

function criticEndpoint() {
  const fallback = { host: '127.0.0.1', port: 8791 }
  const critic = readConfig()?.critic
  if (!critic || typeof critic !== 'object') return fallback
  const host = typeof critic.host === 'string' && critic.host.trim() !== ''
    ? critic.host.trim()
    : fallback.host
  const port = Number.isInteger(critic.port) && critic.port >= 1 && critic.port <= 65535
    ? critic.port
    : fallback.port
  return { host, port }
}

function spawnOptions(cwd) {
  return {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  }
}

function launch(name, command, args, cwd) {
  const child = spawn(command, args, spawnOptions(cwd))
  pipe(child.stdout, name, false)
  pipe(child.stderr, name, true)
  child.on('exit', (code) => {
    if (stopping) return
    process.stdout.write(`${formatLine(name, `退出 ${code ?? 1}`, true)}\n`)
    stop(code ?? 1)
  })
  children.push(child)
  return child
}

function runOnce(name, command, args, cwd) {
  const child = spawn(command, args, spawnOptions(cwd))
  pipe(child.stdout, name, false)
  pipe(child.stderr, name, true)
  children.push(child)
  return new Promise((resolve, reject) => {
    child.on('error', (err) => reject(err))
    child.on('exit', (code) => {
      if (stopping) return
      if (code === 0) resolve()
      else reject(new Error(`${name} 退出 ${code ?? 1}`))
    })
  })
}

function halt(code) {
  if (children.length === 0) {
    cancel('已取消')
    process.exit(code)
  }
  stop(code, true)
}

function stop(code = 0, signal = false) {
  if (stopping) return
  stopping = true
  const alive = children.some((child) => child.pid != null && child.exitCode == null)
  if (signal || alive) process.stdout.write(`\n${styleText('dim', '正在停止')}\n`)
  for (const child of children) {
    if (child.pid == null || child.exitCode != null) continue
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }
  }
  setTimeout(() => process.exit(code), 300)
}

function formatLine(name, line, error) {
  const tag = styleText(tags[name] ?? 'bold', name.padEnd(6))
  const bar = styleText(error ? 'red' : 'dim', '│')
  return `${tag} ${bar} ${line}`
}

function pipe(stream, name, error) {
  if (!stream) return
  let pending = ''
  const emit = (raw) => {
    const cut = raw.lastIndexOf('\r')
    const line = cut === -1 ? raw : raw.slice(cut + 1)
    if (line.replace(/\u001b\[[0-9;]*m/g, '').trim() === '') return
    process.stdout.write(`${formatLine(name, line, error)}\n`)
  }
  stream.on('data', (chunk) => {
    pending += chunk.toString()
    const lines = pending.split(/\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) emit(line)
  })
  stream.on('end', () => {
    if (pending === '') return
    emit(pending)
    pending = ''
  })
}
