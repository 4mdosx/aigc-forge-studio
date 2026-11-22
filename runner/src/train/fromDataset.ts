import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import type { ImageAsset } from '../capture/asset.ts'
import type { Dataset } from '../dataset/records.ts'
import { RunnerError } from '../errors.ts'
import {
  captionFor,
  normalizeTier,
  type TierName,
} from './captionTiers.ts'

// 「选数据集 → 导出 → 推训练机 → 建 job」的服务端版本。
// 对照实现：scripts_and_tools/export_dataset.mjs（导出规则）+ train_animagine.mjs（profile 合并、上传、建 job）。
// 两边行为要保持一致：processed 版本、caption = [trigger,] tags...,、keepTokens 由 trigger 决定。

export const EXPORT_VERSION = 'processed'
export const DEFAULT_BASE_MODEL = 'checkpoints/animagine-xl-4.0-zero.safetensors'

// trainer/src/train/toml.ts 接受的训练字段，白名单挡拼写错误。
export const TRAIN_PARAMS = [
  'resolution',
  'batchSize',
  'numRepeats',
  'networkDim',
  'networkAlpha',
  'unetLr',
  'textEncoderLr',
  'scheduler',
  'lrWarmupSteps',
  'maxTrainEpochs',
  'saveEveryNEpochs',
  'clipSkip',
  'minSnrGamma',
  'sdpa',
  'unetOnly',
  'sdxl',
  'cacheTextEncoderOutputs',
  'shuffleCaption',
  'keepTokens',
  'samplePrompts',
  'sampleEveryNEpochs',
] as const

export type TrainParam = (typeof TRAIN_PARAMS)[number]

export type TrainProfile = {
  desc: string
  expectImages?: readonly number[]
  params: Record<string, unknown>
}

export type ProfileBook = Record<string, TrainProfile>

export type ExportPair = {
  id: string
  source: string
  caption: string
  rating: string
}

const TAGGER_CSV = ['models', 'wd14', 'wd-eva02-large-tagger-v3', 'selected_tags.csv']

export function dirNameOf(name: string): string {
  return name.replace(/[^\w.-]+/g, '-')
}

// 与 export_dataset.mjs 同序：精确 → 单数 → 唯一子串；多条命中视为歧义。
export function pickDataset(
  datasets: readonly Dataset[],
  name: string,
): Dataset | null {
  const exact = datasets.find((d) => d.name === name)
  if (exact) return exact
  const singularName = name.replace(/s$/, '')
  const singular = datasets.find((d) => d.name === singularName)
  if (singular) return singular
  const hits = datasets.filter((d) =>
    d.name.toLowerCase().includes(name.toLowerCase()),
  )
  return hits.length === 1 ? hits[0] : null
}

// 旧签名兼容（辅助脚本/测试直接调）；新调用走 captionFor。
export function captionOf(tags: readonly string[], trigger: string): string {
  return captionFor(tags, { trigger, tier: null, styleTags: [], charNames: new Set() })
}

export type BuildPairsOpts = {
  dataDir: string
  trigger: string
  characters?: ReadonlySet<string>
  // caption 过滤档位；留空 = 旧行为（trigger + 全量 tag）
  tier?: string | null
  // 恒定风格词，每张图都写进 caption（T0/T1 必填）
  styleTags?: readonly string[]
}

export function buildPairs(
  assets: readonly ImageAsset[],
  opts: BuildPairsOpts,
): { pairs: ExportPair[]; skipped: string[] } {
  const tier = normalizeTier(opts.tier ?? null)
  const styleTags = opts.styleTags ?? []
  const chars = opts.characters ?? new Set<string>()
  const pairs: ExportPair[] = []
  const skipped: string[] = []
  for (const asset of assets) {
    const image = asset.processed
    if (!image?.path) {
      skipped.push(`${asset.id}: 无 ${EXPORT_VERSION} 版本 (status=${asset.status})`)
      continue
    }
    const tags = Array.isArray(asset.tags) ? asset.tags : []
    if (tags.length === 0) {
      skipped.push(`${asset.id}: 无 tags`)
      continue
    }
    const source = join(opts.dataDir, image.path)
    if (!existsSync(source)) {
      skipped.push(`${asset.id}: 图片不存在 (${image.path})`)
      continue
    }
    const caption = captionFor(tags, {
      trigger: opts.trigger,
      tier,
      styleTags,
      charNames: chars,
    })
    pairs.push({ id: asset.id, source, caption, rating: asset.rating })
  }
  return { pairs, skipped }
}

// WD14 词表里 category=4 是角色名；导出风格 LoRA 时要剥掉，免得把角色先验写进 caption。
// strict=false：词表缺失时返回空集（测试/无 tagger 环境不阻塞训练）。
export function characterNames(dataDir: string, strict = true): Set<string> {
  const csv = join(dataDir, ...TAGGER_CSV)
  if (!existsSync(csv)) {
    if (!strict) return new Set<string>()
    throw new RunnerError(`找不到 WD14 词表：${csv}`, 400)
  }
  const names = new Set<string>()
  const lines = readFileSync(csv, 'utf8').trim().split('\n').slice(1)
  for (const line of lines) {
    const [, name, category] = line.split(',')
    if (category === '4' && name) names.add(name)
  }
  return names
}

export function loadProfiles(root: string): ProfileBook {
  const path = join(root, 'scripts_and_tools', 'train_profiles.json')
  if (!existsSync(path)) {
    throw new RunnerError(`找不到训练 profile：${path}`, 500)
  }
  return parseProfiles(JSON.parse(readFileSync(path, 'utf8')))
}

export function parseProfiles(raw: unknown): ProfileBook {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RunnerError('train_profiles.json 必须是对象', 500)
  }
  const table = (raw as { profiles?: unknown }).profiles
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    throw new RunnerError('train_profiles.json 缺 profiles 表', 500)
  }
  const book: ProfileBook = {}
  for (const [name, value] of Object.entries(table as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new RunnerError(`profile ${name} 必须是对象`, 500)
    }
    const entry = value as Record<string, unknown>
    const params = entry.params
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new RunnerError(`profile ${name} 缺 params`, 500)
    }
    book[name] = {
      desc: typeof entry.desc === 'string' ? entry.desc : '',
      ...(Array.isArray(entry.expectImages)
        ? { expectImages: entry.expectImages as number[] }
        : {}),
      params: params as Record<string, unknown>,
    }
  }
  return book
}

// 只接受白名单字段，未知键直接报错——别让拼写错误静默变成「没生效」。
export function trainOverridesOf(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RunnerError('params 必须是对象')
  }
  const allowed = new Set<string>(TRAIN_PARAMS)
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(key)) {
      throw new RunnerError(`未知训练参数: ${key}（可用：${TRAIN_PARAMS.join(', ')}）`)
    }
    out[key] = raw
  }
  return out
}

export function stagePairs(
  dataDir: string,
  dirName: string,
  pairs: readonly ExportPair[],
): string {
  const dir = join(dataDir, 'training-export', dirName, 'img')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const pair of pairs) {
    copyFileSync(pair.source, join(dir, `${pair.id}.png`))
    writeFileSync(join(dir, `${pair.id}.txt`), `${pair.caption}\n`)
  }
  return dir
}

export async function uploadPairs(
  trainerBase: string,
  dirName: string,
  stagingDir: string,
  pairs: readonly ExportPair[],
  concurrency = 4,
): Promise<{ pushed: number; failures: string[]; pruned: number }> {
  const target = `${dirName}/img`
  // 先对账：训练机上传目录只写不删，同名数据集重训会把旧图一起喂进去，
  // 步数被悄悄放大（2026-11-22 实踩：本地算 570 步，trainer 按 55 张跑成 1650 步）。
  // 旧版 trainer 没有 /sync，静默跳过——清理失败不该阻断上传。
  let pruned = 0
  try {
    const res = await fetch(
      `${trainerBase}/sync?root=training&path=${encodeURIComponent(target)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          files: pairs.flatMap((pair) => [`${pair.id}.png`, `${pair.id}.txt`]),
        }),
      },
    )
    if (res.ok) {
      const json = (await res.json()) as { deleted?: string[] }
      pruned = json.deleted?.length ?? 0
    }
  } catch {
    // trainer 不可达：交给下面的 put 给出明确错误
  }
  const workers = Math.max(1, Math.min(concurrency, pairs.length))
  const failures: string[] = []
  let pushed = 0
  async function put(path: string, file: string): Promise<void> {
    const url = `${trainerBase}/upload?root=training&path=${encodeURIComponent(path)}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: readFileSync(file),
    })
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`)
  }
  await Promise.all(
    Array.from({ length: workers }, async (_, i) => {
      for (let n = i; n < pairs.length; n += workers) {
        const pair = pairs[n]!
        try {
          await put(`${target}/${pair.id}.png`, join(stagingDir, `${pair.id}.png`))
          await put(`${target}/${pair.id}.txt`, join(stagingDir, `${pair.id}.txt`))
          pushed += 1
        } catch (err) {
          failures.push(err instanceof Error ? err.message : String(err))
        }
      }
    }),
  )
  return { pushed, failures, pruned }
}

// <数据集>-<触发词>-<profile>-az-<YYMMDD-HMM>，与 train_animagine.mjs 的 jobName 同构。
// 触发词进名字：同名数据集换触发词重训出来的产物能一眼分开，ComfyUI 下拉也不会撞名。
// 没给触发词（老调用方/无触发词数据集）时该段整体省略，不留双连字符。
export function jobNameOf(
  dirName: string,
  trigger: string,
  profile: string,
  date: Date = new Date(),
): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, '')
    .slice(2, 12)
    .replace('T', '-')
  return [dirName, trigger.trim(), profile, 'az', stamp]
    .filter((part) => part !== '')
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
}
