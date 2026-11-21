// WD14 tagger 推理核心：SmilingWolf 的 Danbooru 反推器，onnxruntime-node CPU 推理。
// 模型缓存目录：data/models/wd14/<modelId>/（model.onnx + selected_tags.csv）
// 预处理与 SmilingWolf 原实现对齐：RGBA 压白底 → 白 pad 成方形 → resize 到模型边长 → RGB/255 → BGR。
// onnxruntime-node 延迟 import（纯函数测试不背原生依赖）。

import { execFile as execFileCb } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { InferenceSession } from 'onnxruntime-node'

import { RunnerError } from '../errors.ts'

const execFile = promisify(execFileCb)

// HF 直连不稳时走本地代理（与 capture 同一套约定，可用环境变量覆盖）
const PROXY = process.env.WD14_PROXY ?? process.env.CAPTURE_PROXY ?? 'http://127.0.0.1:7897'
// 国内可换 hf-mirror.com
const HF_BASE = process.env.WD14_HF_BASE ?? 'https://huggingface.co'

export const WD14_MODELS = {
  'wd-eva02-large-tagger-v3': { repo: 'SmilingWolf/wd-eva02-large-tagger-v3', size: 448 },
  'wd-v1-4-convnextv2-tagger-v2': { repo: 'SmilingWolf/wd-v1-4-convnextv2-tagger-v2', size: 448 },
  'wd-v1-4-moat-tagger-v2': { repo: 'SmilingWolf/wd-v1-4-moat-tagger-v2', size: 448 },
  'wd-v1-4-swinv2-tagger-v2': { repo: 'SmilingWolf/wd-v1-4-swinv2-tagger-v2', size: 448 },
} as const satisfies Record<string, { repo: string; size: number }>

export type Wd14ModelId = keyof typeof WD14_MODELS

export const DEFAULT_WD14_MODEL: Wd14ModelId = 'wd-eva02-large-tagger-v3'

// selected_tags.csv 的 category 列：0=general 1=artist 3=copyright 4=character 9=rating/meta
export const CATEGORY = { general: 0, artist: 1, copyright: 3, character: 4, rating: 9 } as const

// ---- 纯函数（测试覆盖） ----

export interface TagEntry {
  name: string
  category: number
}

export function parseTagsCsv(text: string): TagEntry[] {
  const lines = text.split(/\r?\n/)
  if (lines.length === 0) throw new RunnerError('selected_tags.csv is empty')
  const entries: TagEntry[] = []
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue
    const columns = line.split(',')
    const name = (columns[1] ?? '').trim()
    if (name === '') continue
    entries.push({ name, category: Number(columns[2] ?? 0) })
  }
  if (entries.length === 0) throw new RunnerError('selected_tags.csv has no rows')
  return entries
}

export interface TagOptions {
  generalThreshold?: number
  characterThreshold?: number
  excludeTags?: string[]
}

// 带 category 的单个检出标签（展示/分组用，不进 caption）
export interface TagDetail {
  name: string
  category: number
  score: number
}

export interface TagResult {
  // 进 caption 的 tag：general（过阈值）+ character（过阈值），artist/copyright/rating 剔除
  tags: string[]
  rating: string
  // 全量检出（含 artist/copyright/rating），按置信度降序，供页面结构化分组
  details: TagDetail[]
}

// 输出向量与 entries 逐一对应；rating 取最高分的 rating 类标签，其余按阈值筛选、按置信度降序。
// details 与 tags 分开：tags 是 caption 真相源（保持既有行为不变），details 是展示真相源。
export function selectTags(
  scores: ArrayLike<number>,
  entries: TagEntry[],
  options: TagOptions = {},
): TagResult {
  const generalThreshold = options.generalThreshold ?? 0.35
  const characterThreshold = options.characterThreshold ?? 0.85
  const exclude = new Set((options.excludeTags ?? []).map(normalizeTagName))
  if (scores.length !== entries.length) {
    throw new RunnerError(
      `output size ${scores.length} != selected_tags.csv rows ${entries.length}`,
    )
  }

  let rating = ''
  let ratingScore = -1
  const picked: TagDetail[] = []
  const details: TagDetail[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as TagEntry
    const score = scores[index] ?? 0
    const detail: TagDetail = { name: entry.name, category: entry.category, score }
    if (entry.category === CATEGORY.rating) {
      details.push(detail)
      if (score > ratingScore) {
        rating = entry.name
        ratingScore = score
      }
      continue
    }
    // artist / copyright 进 details 展示，但不进 caption（画师名污染风格数据集）
    if (entry.category === CATEGORY.artist || entry.category === CATEGORY.copyright) {
      if (score >= generalThreshold) details.push(detail)
      continue
    }
    if (exclude.has(normalizeTagName(entry.name))) continue
    if (entry.category === CATEGORY.character) {
      if (score >= characterThreshold) {
        picked.push(detail)
        details.push(detail)
      } else if (score >= generalThreshold) {
        details.push(detail)
      }
      continue
    }
    if (entry.category === CATEGORY.general && score >= generalThreshold) {
      picked.push(detail)
      details.push(detail)
    }
  }
  const byScore = (a: TagDetail, b: TagDetail) => b.score - a.score
  picked.sort(byScore)
  details.sort(byScore)
  return { tags: picked.map((item) => item.name), rating, details }
}

// exclude 匹配宽松化：大小写、下划线/空格等价（与 TK WD14 node 同约定）
function normalizeTagName(name: string): string {
  return name.toLowerCase().replace(/[_\s]+/g, ' ')
}

// ---- 模型缓存与下载 ----

function modelDirOf(modelsDir: string, modelId: Wd14ModelId): string {
  return join(modelsDir, 'wd14', modelId)
}

function curlMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function curlDownload(url: string, dest: string): Promise<void> {
  const base = [
    '-sSL',
    '--fail',
    '--connect-timeout',
    '10',
    '--max-filesize',
    '4294967296',
    '-o',
    `${dest}.part`,
    url,
  ]
  const timeoutMs = 3600 * 1000
  let first = ''
  try {
    await execFile('curl', base, { timeout: timeoutMs, maxBuffer: 1024 * 1024 })
  } catch (err) {
    first = curlMessage(err)
  }
  if (first !== '') {
    try {
      await execFile(
        'curl',
        [...base, '--proxy', PROXY, '--max-time', '3500'],
        { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      )
    } catch (err) {
      rmSync(`${dest}.part`, { force: true })
      throw new RunnerError(
        `模型下载失败（直连：${first} / 代理：${curlMessage(err)}）：${url}`,
        502,
      )
    }
  }
  renameSync(`${dest}.part`, dest)
}

// 确保 model.onnx 与 selected_tags.csv 就位（.part 落盘后原子改名）
async function ensureModelFiles(
  modelId: Wd14ModelId,
  dir: string,
): Promise<void> {
  const { repo } = WD14_MODELS[modelId]
  mkdirSync(dir, { recursive: true })
  const files = [
    ['model.onnx', 'model.onnx'],
    ['selected_tags.csv', 'selected_tags.csv'],
  ] as const
  for (const [filename, remote] of files) {
    const dest = join(dir, filename)
    if (existsSync(dest)) continue
    await curlDownload(`${HF_BASE}/${repo}/resolve/main/${remote}`, dest)
  }
}

// ---- 会话（进程内懒加载，每模型一个） ----

export interface Wd14Session {
  modelId: Wd14ModelId
  session: InferenceSession
  entries: TagEntry[]
  size: number
}

const sessions = new Map<Wd14ModelId, Promise<Wd14Session>>()

export function isModelLoaded(modelId: Wd14ModelId): boolean {
  return sessions.has(modelId)
}

// status 端点用：模型文件是否已在磁盘
export function isModelCached(modelsDir: string, modelId: Wd14ModelId): boolean {
  const dir = modelDirOf(modelsDir, modelId)
  return existsSync(join(dir, 'model.onnx')) && existsSync(join(dir, 'selected_tags.csv'))
}

// 只读 CSV 的 category 查表，不加载 ONNX 会话（老数据补 category 用）。进程内按目录缓存。
const categoryMaps = new Map<string, Map<string, number>>()

export function loadCategoryMap(modelsDir: string, modelId: Wd14ModelId): Map<string, number> {
  const dir = modelDirOf(modelsDir, modelId)
  const cached = categoryMaps.get(dir)
  if (cached) return cached
  const csv = join(dir, 'selected_tags.csv')
  if (!existsSync(csv)) return new Map()
  const map = new Map<string, number>()
  for (const entry of parseTagsCsv(readFileSync(csv, 'utf8'))) {
    map.set(entry.name, entry.category)
  }
  categoryMaps.set(dir, map)
  return map
}

export function loadSession(
  modelsDir: string,
  modelId: Wd14ModelId,
  log: (message: string) => void,
): Promise<Wd14Session> {
  const existing = sessions.get(modelId)
  if (existing) return existing
  const creating = (async (): Promise<Wd14Session> => {
    const dir = modelDirOf(modelsDir, modelId)
    if (!isModelCached(modelsDir, modelId)) {
      log(`wd14: downloading ${modelId}`)
      await ensureModelFiles(modelId, dir)
      log(`wd14: downloaded ${modelId}`)
    }
    const ort = (await import('onnxruntime-node')).default
    const session = await ort.InferenceSession.create(join(dir, 'model.onnx'))
    const entries = parseTagsCsv(readFileSync(join(dir, 'selected_tags.csv'), 'utf8'))
    const result: Wd14Session = {
      modelId,
      session,
      entries,
      size: WD14_MODELS[modelId].size,
    }
    log(`wd14: session ready ${modelId} (${entries.length} tags)`)
    return result
  })()
  sessions.set(modelId, creating)
  creating.catch(() => {
    // 下载/加载失败允许下次重试
    sessions.delete(modelId)
  })
  return creating
}

// ---- 单图推理 ----

export async function tagFile(
  file: string,
  ses: Wd14Session,
  options: TagOptions = {},
): Promise<TagResult> {
  const sharp = (await import('sharp')).default
  const { width, height, data } = await sharp(file)
    .rotate() // EXIF 方向
    .flatten({ background: { r: 255, g: 255, b: 255 } }) // RGBA 压白底
    .resize(ses.size, ses.size, {
      fit: 'contain',
      // 白底 contain：等价于原实现的 pad-to-square + resize
      background: { r: 255, g: 255, b: 255 },
    })
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => ({ width: info.width, height: info.height, data }))

  // RGB → BGR。值域注意：WD14 系 ONNX 吃 0..255 float32（不做 /255——
  // /255 会把激活压扁，输出退化成先验常数，如恒定 monochrome/greyscale）
  const pixels = width * height
  const tensorData = new Float32Array(pixels * 3)
  for (let index = 0; index < pixels; index += 1) {
    tensorData[index * 3] = data[index * 3 + 2] ?? 0
    tensorData[index * 3 + 1] = data[index * 3 + 1] ?? 0
    tensorData[index * 3 + 2] = data[index * 3] ?? 0
  }
  const { Tensor } = (await import('onnxruntime-node')).default
  const inputName = ses.session.inputNames[0]
  if (!inputName) throw new RunnerError('onnx session has no input')
  const feeds = {
    [inputName]: new Tensor('float32', tensorData, [1, ses.size, ses.size, 3]),
  }
  const results = await ses.session.run(feeds)
  const outputName = ses.session.outputNames[0]
  const output = outputName ? results[outputName] : undefined
  if (!output) throw new RunnerError('onnx session has no output')
  return selectTags(output.data as Float32Array, ses.entries, options)
}
