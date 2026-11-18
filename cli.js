#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const modes = [
  { id: 'dev', label: 'dev' },
  { id: 'deploy', label: 'deploy' },
]

const children = []
let stopping = false

if (!process.stdin.isTTY) {
  console.error('需要在终端里选择模式和服务')
  process.exit(1)
}

await main()

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const mode = await choose(rl, '模式', modes)
  const selected = await chooseMany(rl, '服务', serviceOptions())
  rl.close()

  const ids = new Set(selected.map((item) => item.id))
  const script = mode.id === 'dev' ? 'dev' : 'start'
  const runner = ids.has('runner+web') ? nodeApp('runner') : ''
  const web = ids.has('runner+web') ? nodeApp('web') : ''
  const python = ids.has('critic') ? pythonBin() : ''

  if (ids.has('runner+web') && mode.id === 'deploy') {
    console.log('构建 web')
    try {
      await runOnce('web', npm, ['run', 'build'], web)
    } catch (err) {
      console.error(err instanceof Error ? err.message : err)
      stop(1)
      return
    }
  }
  if (ids.has('runner+web')) {
    console.log(`启动 runner+web (${mode.id})`)
    launch('runner', npm, ['run', script], runner)
    launch('web', npm, ['run', script], web)
  }
  if (ids.has('critic')) {
    const { host, port } = criticEndpoint()
    console.log(`启动 critic (${mode.id}) http://${host}:${port}`)
    launch('critic', python, [
      join(root, 'critic', 'server.py'),
      '--host', host,
      '--port', String(port),
    ], root)
  }
}

function ask(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve)
  })
}

async function choose(rl, title, options) {
  console.log(title)
  for (const [index, option] of options.entries()) {
    console.log(`  ${index + 1}  ${option.label}`)
  }
  for (;;) {
    const answer = (await ask(rl, '> ')).trim().toLowerCase()
    const hit = matchOption(answer, options)
    if (hit) return hit
    console.log(`输入 1 到 ${options.length}`)
  }
}

async function chooseMany(rl, title, options) {
  const picked = new Set()
  const width = Math.max(...options.map((option) => option.label.length))
  for (;;) {
    console.log(`\n${title}  输入序号切换，回车确认`)
    for (const [index, option] of options.entries()) {
      const mark = picked.has(option.id) ? 'x' : ' '
      console.log(`  ${index + 1}  [${mark}] ${option.label.padEnd(width)}  ${option.detail}`)
    }
    const answer = (await ask(rl, '> ')).trim().toLowerCase()
    if (answer === '' || answer === 'ok' || answer === '确认') {
      if (picked.size === 0) {
        console.log('至少选一个')
        continue
      }
      const chosen = options.filter((option) => picked.has(option.id))
      console.log(`已选 ${chosen.map((option) => option.label).join('、')}`)
      const confirm = (await ask(rl, '回车启动，n 返回 > ')).trim().toLowerCase()
      if (confirm === '' || confirm === 'y' || confirm === 'yes' || confirm === 'ok' || confirm === '确认') {
        return chosen
      }
      continue
    }
    const tokens = answer.split(/[\s,]+/).filter(Boolean)
    const hits = []
    let invalid = ''
    for (const token of tokens) {
      const option = matchOption(token, options)
      if (!option) {
        invalid = token
        break
      }
      hits.push(option)
    }
    if (invalid) {
      console.log(`没有 ${invalid}，输入 1 到 ${options.length}`)
      continue
    }
    for (const option of hits) {
      if (picked.has(option.id)) picked.delete(option.id)
      else picked.add(option.id)
    }
  }
}

function matchOption(answer, options) {
  const index = Number(answer)
  if (Number.isInteger(index) && index >= 1 && index <= options.length) {
    return options[index - 1]
  }
  return options.find((option) => option.id === answer || option.label === answer)
}

function serviceOptions() {
  const critic = criticEndpoint()
  return [
    { id: 'runner+web', label: 'runner+web', detail: `Runner ${runnerPort()}，Web 3000` },
    { id: 'critic', label: 'critic', detail: `${critic.host}:${critic.port}` },
  ]
}

function runnerPort() {
  try {
    const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
    const port = config?.runner?.port
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port
  } catch {
    return 8787
  }
  return 8787
}

function nodeApp(name) {
  const cwd = join(root, name)
  if (!existsSync(join(cwd, 'node_modules'))) {
    console.error(`${name}: 先在 ${cwd} 执行 npm install`)
    process.exit(1)
  }
  return cwd
}

function pythonBin() {
  const bin = process.platform === 'win32'
    ? join(root, '.venv', 'Scripts', 'python.exe')
    : join(root, '.venv', 'bin', 'python')
  if (!existsSync(bin)) {
    console.error('critic: 先在仓库根目录创建 .venv 并安装 critic/requirements.txt')
    process.exit(1)
  }
  return bin
}

function criticEndpoint() {
  const fallback = { host: '127.0.0.1', port: 8791 }
  let config
  try {
    config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
  } catch {
    return fallback
  }
  const critic = config?.critic
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
  pipe(child.stdout, name)
  pipe(child.stderr, name)
  child.on('exit', (code) => {
    if (stopping) return
    console.error(`[${name}] 退出 ${code ?? 1}`)
    stop(code ?? 1)
  })
  children.push(child)
  return child
}

function runOnce(name, command, args, cwd) {
  const child = spawn(command, args, spawnOptions(cwd))
  pipe(child.stdout, name)
  pipe(child.stderr, name)
  children.push(child)
  return new Promise((resolve, reject) => {
    child.on('error', (err) => reject(err))
    child.on('exit', (code) => {
      if (stopping) return
      if (code === 0) resolve()
      else reject(new Error(`[${name}] 退出 ${code ?? 1}`))
    })
  })
}

function stop(code = 0) {
  if (stopping) return
  stopping = true
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

function pipe(stream, name) {
  if (!stream) return
  let pending = ''
  stream.on('data', (chunk) => {
    pending += chunk.toString()
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) console.log(`[${name}] ${line}`)
  })
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
