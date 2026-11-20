#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify, styleText } from 'node:util'
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
const execFileAsync = promisify(execFile)
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

  try {
    if (ids.has('runner+web')) {
      await freePort('runner', runner.port)
      await freePort('web', webPort)
    }
    if (ids.has('critic')) await freePort('critic', critic.port)
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

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

async function freePort(name, port) {
  const owned = await portTargets(port)
  if (owned.length === 0) return
  const pids = owned.map((item) => item.pid).join('、')
  process.stdout.write(`${formatLine(name, `${port} 已被占用，结束 ${pids}`)}\n`)
  for (const item of owned) signalTarget(item, 'SIGTERM')
  if (await waitUntilFree(port)) return
  for (const item of await portTargets(port)) signalTarget(item, 'SIGKILL')
  if (await waitUntilFree(port)) return
  const left = await listenerPids(port)
  throw new Error(`${name}: ${port} 仍被 ${left.join('、') || '未知进程'} 占用`)
}

async function waitUntilFree(port) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await listenerPids(port)).length === 0) return true
    await sleep(100)
  }
  return false
}

async function portTargets(port) {
  const listening = (await listenerPids(port)).filter((pid) => pid !== process.pid && pid !== 1)
  if (listening.length === 0) return []
  const table = await processTable()
  const byPid = new Map(table.map((row) => [row.pid, row]))
  const targets = new Map()
  for (const pid of listening) {
    const target = killTarget(pid, byPid, table)
    if (target) targets.set(`${target.kind}:${target.pid}`, target)
  }
  return [...targets.values()]
}

function killTarget(pid, byPid, table) {
  const start = byPid.get(pid)
  if (!start) return { kind: 'pid', pid }
  const leader = byPid.get(start.pgid)
  const groupIsOurs = leader
    && leader.pid !== process.pid
    && leader.pid > 1
    && isService(leader.command)
    && !isShell(leader.command)
    && !table.some((row) => row.pgid === start.pgid && (row.pid === process.pid || isShell(row.command)))
  if (groupIsOurs) return { kind: 'group', pid: leader.pid }
  let current = start
  let top = pid
  const seen = new Set()
  while (current && !seen.has(current.pid)) {
    seen.add(current.pid)
    const parent = byPid.get(current.ppid)
    if (!parent || parent.pid <= 1 || parent.pid === process.pid) break
    if (isShell(parent.command) || !isService(parent.command)) break
    top = parent.pid
    current = parent
  }
  if (top === process.pid || top <= 1) return null
  return { kind: 'pid', pid: top }
}

function isService(command) {
  if (/(?:^|[/\s])(node|npm|npx|python\d*(?:\.\d+)?)(?:\s|$)/.test(command)) return true
  if (command.includes('next-server') || command.includes(`${root}/`)) return true
  return /\bsh\b/.test(command) && /\b(node|npm|python)\b/.test(command)
}

function isShell(command) {
  const base = command.trim().split(/\s+/)[0]?.split('/').pop() ?? ''
  if (base === 'sh' && /\s-c\s/.test(command)) return false
  return ['zsh', 'bash', 'sh', 'dash', 'fish', 'tcsh', 'login', 'tmux', 'screen'].includes(base)
}

function signalTarget(target, signal) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(target.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    return
  }
  const pid = target.kind === 'group' ? -target.pid : target.pid
  try {
    process.kill(pid, signal)
  } catch {
    if (target.kind === 'group') {
      try {
        process.kill(target.pid, signal)
      } catch {
        // 进程已经退出
      }
    }
  }
}

async function listenerPids(port) {
  if (process.platform === 'win32') {
    const stdout = await capture('netstat', ['-ano', '-p', 'tcp'])
    const pids = new Set()
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 5 || !parts[3]?.toUpperCase().startsWith('LISTEN')) continue
      if (portOf(parts[1]) !== port) continue
      const pid = Number(parts[4])
      if (Number.isInteger(pid) && pid > 0) pids.add(pid)
    }
    return [...pids]
  }
  const stdout = await capture('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
  return [...new Set(stdout.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))]
}

function portOf(address) {
  const index = address?.lastIndexOf(':') ?? -1
  if (index < 0) return NaN
  return Number(address.slice(index + 1))
}

async function processTable() {
  if (process.platform === 'win32') {
    const stdout = await capture('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "{0}`t{1}`t{2}" -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }',
    ])
    return stdout.split(/\r?\n/).flatMap((line) => {
      const [pid, ppid, ...command] = line.split('\t')
      const id = Number(pid)
      const parent = Number(ppid)
      if (!Number.isInteger(id) || !Number.isInteger(parent)) return []
      return [{ pid: id, ppid: parent, pgid: id, command: command.join('\t') }]
    })
  }
  const stdout = await capture('ps', ['-ax', '-o', 'pid=,ppid=,pgid=,command='])
  return stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) return []
    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4],
    }]
  })
}

async function capture(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    })
    return String(stdout ?? '')
  } catch (err) {
    const code = err && typeof err === 'object' ? err.code : undefined
    if (code === 1 || code === '1') return String(err.stdout ?? '')
    throw err
  }
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
