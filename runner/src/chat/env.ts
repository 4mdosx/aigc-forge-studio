import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { RunnerError } from '../errors.ts'

export interface GatewayConfig {
  apiKey: string
  baseURL: string
  models: string[]
  visionModel: string
}

export async function loadGateway(root: string): Promise<GatewayConfig | null> {
  const path = join(root, 'env.ts')
  if (!existsSync(path)) return null
  let source: Record<string, unknown>
  try {
    source = (await import(pathToFileURL(path).href)) as Record<string, unknown>
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new RunnerError(`cannot load env.ts: ${detail}`)
  }
  return readGateway(source)
}

export function readGateway(
  source: Record<string, unknown>,
): GatewayConfig | null {
  const apiKey = text(source.AI_GATEWAY_KEY)
  const baseURL = text(source.AI_GATEWAY_URL).replace(/\/+$/, '')
  if (apiKey === '' || baseURL === '') return null
  return {
    apiKey,
    baseURL,
    models: modelList(source.AI_GATEWAY_MODEL),
    visionModel: text(source.AI_GATEWAY_VISION_MODEL),
  }
}

function modelList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RunnerError(
      'AI_GATEWAY_MODEL must be a list of model names in env.ts',
    )
  }
  const models: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new RunnerError(
        'AI_GATEWAY_MODEL must be a list of model names in env.ts',
      )
    }
    const name = item.trim()
    if (!models.includes(name)) models.push(name)
  }
  return models
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

// 浏览器登录 pixiv 后 Cookie 里的 PHPSESSID。空字符串或没有这一项表示不带登录态。
// 接受裸值、`PHPSESSID=值`，或整段 Cookie。
export function pixivSessionValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const named = /(?:^|;\s*)PHPSESSID=([^;\s]+)/i.exec(trimmed)
  const token = named?.[1] ?? trimmed
  if (!/^[A-Za-z0-9_]+$/.test(token)) {
    throw new RunnerError('PIXIV_PHPSESSID 要填浏览器 Cookie 里 PHPSESSID 的值')
  }
  return token
}

export function pixivSessionFromFile(text: string): string | null {
  const match = /export\s+const\s+PIXIV_PHPSESSID\s*=\s*(['"])(.*?)\1/.exec(
    text,
  )
  if (!match) return null
  return pixivSessionValue(match[2] ?? '')
}
