import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { hashPin, pinMatches } from './pin-crypto.ts'

export type AuthFile = {
  hash?: string
  epoch?: string
  updatedAt?: string
  secret?: string
}

export function authFilePath(): string {
  if (process.env.WEB_AUTH_FILE) return process.env.WEB_AUTH_FILE
  const roots = [process.cwd(), join(process.cwd(), '..')]
  for (const root of roots) {
    if (existsSync(join(root, 'config.json'))) return join(root, 'data', 'web-auth.json')
  }
  return join(process.cwd(), '..', 'data', 'web-auth.json')
}

function read(file = authFilePath()): AuthFile {
  if (!existsSync(file)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`无法读取 PIN 存储：${file}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`无法读取 PIN 存储：${file}`)
  }
  const record = parsed as AuthFile
  return {
    hash: typeof record.hash === 'string' ? record.hash : undefined,
    epoch: typeof record.epoch === 'string' ? record.epoch : undefined,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
    secret: typeof record.secret === 'string' ? record.secret : undefined,
  }
}

function write(next: AuthFile, file = authFilePath()) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const body: AuthFile = {}
  if (next.hash) body.hash = next.hash
  if (next.epoch) body.epoch = next.epoch
  if (next.updatedAt) body.updatedAt = next.updatedAt
  if (next.secret) body.secret = next.secret
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
  try {
    renameSync(tmp, file)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM') {
      unlinkSync(tmp)
      throw err
    }
    // Windows 的 rename 不能覆盖已有文件。
    if (existsSync(file)) unlinkSync(file)
    renameSync(tmp, file)
  }
}

export function readAuth(file = authFilePath()): AuthFile {
  return read(file)
}

export function isPinConfigured(file = authFilePath()): boolean {
  return Boolean(read(file).hash)
}

export function getPinEpoch(file = authFilePath()): string | null {
  const auth = read(file)
  if (!auth.hash || !auth.epoch) return null
  return auth.epoch
}

export function getPinStatus(file = authFilePath()): {
  configured: boolean
  updatedAt: string | null
} {
  const auth = read(file)
  return {
    configured: Boolean(auth.hash),
    updatedAt: auth.hash ? (auth.updatedAt ?? null) : null,
  }
}

export function sessionSecret(file = authFilePath()): string {
  const current = read(file)
  if (current.secret && current.secret.length >= 32) return current.secret
  const secret = randomBytes(32).toString('base64url')
  write({ ...current, secret }, file)
  return secret
}

export async function savePin(pin: string, file = authFilePath()): Promise<string> {
  const current = read(file)
  const secret =
    current.secret && current.secret.length >= 32
      ? current.secret
      : randomBytes(32).toString('base64url')
  const epoch = randomUUID()
  write(
    {
      hash: await hashPin(pin),
      epoch,
      updatedAt: new Date().toISOString(),
      secret,
    },
    file,
  )
  return epoch
}

export async function verifyStoredPin(pin: string, file = authFilePath()): Promise<boolean> {
  const stored = read(file).hash
  if (!stored) return false
  return pinMatches(pin, stored)
}

export function clearStoredPin(file = authFilePath()): boolean {
  if (!existsSync(file)) return false
  const current = read(file)
  if (!current.hash) return false
  write({ secret: current.secret }, file)
  return true
}
