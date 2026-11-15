// prompt 组装层（2026-11-15 token 定稿三段模型）
//
// repaint 的 prompt 不再由调用方拼终值，而是三段组装：
//   素材段（原始 prompt，语义锚定）— payload.rawPositive/rawNegative，或 /trace 溯源
//   目的段（workflow 级默认）      — adapter_json 顶层 prompt 块（随版本）
//   方言段（模型相关）            — checkpoint 元数据 promptProfileId → promptProfiles.json
// compose 在 createTask 内、applyAdapter 之前发生；payload.positive 直通语义保留。
//
// 纪律：本模块只做纯字符串组装，不碰 DB / HTTP。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { RunnerError } from '../errors.ts'
import type { Prompt } from '../workflow/graph.ts'

export interface PromptProfile {
  qualityPos: 'start' | 'end'
  qualityStart?: string[]
  qualityEnd?: string[]
  // 已知各方言的质量词并集：素材段里的质量类 tag 一律剥除，由本方言重放
  stripForeign?: string[]
  negativeBase?: string[]
}

export interface PromptIntent {
  compose?: boolean
  anchors?: string[]
  negativeExtra?: string[]
}

export interface AdapterPrompt {
  prompt?: PromptIntent
}

export interface ComposeInput {
  materialPositive: string
  materialNegative?: string
  anchors?: string[]
  negativeExtra?: string[]
  profile: PromptProfile
}

export interface ComposedPrompt {
  positive: string
  negative: string
}

export function composePrompt(input: ComposeInput): ComposedPrompt {
  const { profile } = input
  const material = splitTags(input.materialPositive)
  const stripped = stripTags(material, [
    ...(profile.stripForeign ?? []),
    ...(profile.qualityStart ?? []),
    ...(profile.qualityEnd ?? []),
  ])
  const quality = profile.qualityPos === 'start'
    ? profile.qualityStart ?? []
    : profile.qualityEnd ?? []
  const parts =
    profile.qualityPos === 'start'
      ? [...quality, ...stripped, ...(input.anchors ?? [])]
      : [...stripped, ...(input.anchors ?? []), ...quality]
  const positive = dedupTags(parts)
  const negative = dedupTags([
    ...(profile.negativeBase ?? []),
    ...splitTags(input.materialNegative ?? ''),
    ...(input.negativeExtra ?? []),
  ])
  return { positive, negative }
}

// --- 数据文件读取（dataDir 由 runner 提供，默认 data/） ---

export function profileForCheckpoint(dataDir: string, ckptName: string): PromptProfile {
  const dir = join(dataDir, 'models', 'checkpoint')
  const target = ckptName.replace(/^.*\//, '')
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    let meta: { path?: unknown; promptProfileId?: unknown }
    try {
      meta = JSON.parse(readFileSync(join(dir, file), 'utf8')) as typeof meta
    } catch {
      continue
    }
    if (typeof meta.path !== 'string') continue
    if (meta.path.replace(/^.*\//, '') !== target) continue
    if (typeof meta.promptProfileId !== 'string') {
      throw new RunnerError(
        `checkpoint ${target} has no promptProfileId (compose unavailable)`,
      )
    }
    return loadProfile(dataDir, meta.promptProfileId)
  }
  throw new RunnerError(`no checkpoint metadata matches ${target}`)
}

export function loadProfile(dataDir: string, id: string): PromptProfile {
  const file = join(dataDir, 'models', 'promptProfiles.json')
  const raw = JSON.parse(readFileSync(file, 'utf8')) as {
    profiles?: Record<string, unknown>
  }
  const profile = raw.profiles?.[id] as Record<string, unknown> | undefined
  if (!profile || typeof profile !== 'object') {
    throw new RunnerError(`prompt profile ${id} not found`)
  }
  return normalizeProfile(profile)
}

function normalizeProfile(raw: Record<string, unknown>): PromptProfile {
  if (raw.qualityPos !== 'start' && raw.qualityPos !== 'end') {
    throw new RunnerError('prompt profile qualityPos must be start or end')
  }
  return {
    qualityPos: raw.qualityPos,
    qualityStart: stringList(raw.qualityStart),
    qualityEnd: stringList(raw.qualityEnd),
    stripForeign: stringList(raw.stripForeign),
    negativeBase: stringList(raw.negativeBase),
  }
}

function stringList(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
    throw new RunnerError('prompt profile lists must be string arrays')
  }
  return raw as string[]
}

// --- 任务侧入口 ---

// 从 api prompt 里取 checkpoint 文件名（Compose 前提：图里恰好一个 CheckpointLoaderSimple）
export function ckptNameOf(api: Prompt): string {
  const loaders = Object.values(api).filter(
    (node) => node.class_type === 'CheckpointLoaderSimple',
  )
  if (loaders.length !== 1) {
    throw new RunnerError(
      `compose expects exactly one CheckpointLoaderSimple, found ${loaders.length}`,
    )
  }
  const name = (loaders[0]?.inputs as Record<string, unknown>)?.ckpt_name
  if (typeof name !== 'string') throw new RunnerError('checkpoint node has no ckpt_name')
  return name
}

// createTask 内、applyAdapter 之前调用：把 rawPositive/rawNegative 组装成
// positive/negative 写回 payload。没有 compose 配置且调用方也没传 raw 时为直通。
export function applyCompose(
  api: Prompt,
  adapter: AdapterPrompt,
  payload: Record<string, unknown>,
  dataDir: string,
): void {
  const wantsRaw =
    payload.rawPositive !== undefined || payload.rawNegative !== undefined
  if (!adapter.prompt?.compose) {
    if (wantsRaw) {
      throw new RunnerError(
        'payload has rawPositive/rawNegative but adapter has no prompt.compose config',
      )
    }
    return
  }
  if (typeof payload.rawPositive !== 'string') {
    throw new RunnerError('prompt.compose requires payload.rawPositive as string')
  }
  if (
    payload.rawNegative !== undefined &&
    typeof payload.rawNegative !== 'string'
  ) {
    throw new RunnerError('payload.rawNegative must be a string')
  }
  const anchors = stringList(adapter.prompt.anchors) ?? []
  const negativeExtra = stringList(adapter.prompt.negativeExtra) ?? []
  const profile = profileForCheckpoint(dataDir, ckptNameOf(api))
  const composed = composePrompt({
    materialPositive: payload.rawPositive,
    materialNegative: payload.rawNegative as string | undefined,
    anchors,
    negativeExtra,
    profile,
  })
  payload.positive = composed.positive
  payload.negative = composed.negative
  delete payload.rawPositive
  delete payload.rawNegative
}

// --- tag 工具 ---

function splitTags(text: string): string[] {
  return text
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '')
}

function stripTags(tags: string[], strip: string[]): string[] {
  if (strip.length === 0) return tags
  const set = new Set(strip.map((tag) => tag.trim().toLowerCase()).filter(Boolean))
  return tags.filter((tag) => !set.has(tag.toLowerCase()))
}

function dedupTags(tags: string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of tags) {
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out.join(', ')
}
