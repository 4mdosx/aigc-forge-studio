#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const services = [
  ['runner', join(root, 'runner')],
  ['web', join(root, 'web')],
]

for (const [name, cwd] of services) {
  if (!existsSync(join(cwd, 'node_modules'))) {
    console.error(`${name}: 先在 ${cwd} 执行 npm install`)
    process.exit(1)
  }
}

const children = services.map(([name, cwd]) => {
  const child = spawn(npm, ['run', 'dev'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  pipe(child.stdout, name)
  pipe(child.stderr, name)
  child.on('exit', (code) => {
    if (stopping) return
    console.error(`[${name}] 退出 ${code ?? 1}`)
    stop(code ?? 1)
  })
  return child
})

let stopping = false

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
