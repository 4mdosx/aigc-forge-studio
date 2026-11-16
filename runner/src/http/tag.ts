import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Hono } from 'hono'

import {
  DEFAULT_WD14_MODEL,
  WD14_MODELS,
  isModelCached,
  isModelLoaded,
  loadSession,
  tagFile,
  type TagOptions,
  type Wd14ModelId,
} from '../tag/wd14.ts'
import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'
import { isFolderName, readMeta, writeMeta } from './capture.ts'
import { jsonObject, stringField } from './request.ts'

// 自动打标台：WD14 给 data/capture/<folder>/image/ 批量生成 booru tag。
// 目录即真相源的延伸：产物 image/<id>.txt（逗号分隔，置信度降序）+ sidecar meta
// （tags/tagRating/tagger/阈值/taggedAt）。打标只针对预处理产出的 jpg。
// artist/copyright 默认剔除（画师名会污染风格 LoRA）；rating 只存 meta 不进 txt。

interface TagJob {
  folder: string
  modelId: Wd14ModelId
  total: number
  done: number
  failed: number
  status: 'loading' | 'running' | 'done' | 'error'
  error: string | null
  startedAt: string
  finishedAt: string | null
}

// 进程内任务表；runner 重启丢进度，sidecar 里的 tags/taggedAt 不丢
const jobs = new Map<string, TagJob>()

// 模型缓存根：data/models/wd14/<modelId>/
function modelsDirOf(runner: Runner): string {
  return join(runner.dataDir, 'models')
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function log(message: string): void {
  console.error(`[tag] ${message}`)
}

function modelIdOf(body: Record<string, unknown>): Wd14ModelId {
  if (body.model === undefined) return DEFAULT_WD14_MODEL
  if (typeof body.model !== 'string' || !Object.hasOwn(WD14_MODELS, body.model)) {
    throw new RunnerError(`model must be one of: ${Object.keys(WD14_MODELS).join(', ')}`)
  }
  return body.model as Wd14ModelId
}

function optionsOf(body: Record<string, unknown>): TagOptions & { excludeTags: string[] } {
  const threshold = body.threshold
  if (
    threshold !== undefined &&
    (typeof threshold !== 'number' || threshold <= 0 || threshold >= 1)
  ) {
    throw new RunnerError('threshold must be a number in (0, 1)')
  }
  const characterThreshold = body.characterThreshold
  if (
    characterThreshold !== undefined &&
    (typeof characterThreshold !== 'number' ||
      characterThreshold <= 0 ||
      characterThreshold >= 1)
  ) {
    throw new RunnerError('characterThreshold must be a number in (0, 1)')
  }
  let excludeTags: string[] = []
  const rawExclude = body.excludeTags
  if (rawExclude !== undefined) {
    if (typeof rawExclude !== 'string') throw new RunnerError('excludeTags must be a string')
    excludeTags = rawExclude
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '')
  }
  return { generalThreshold: threshold, characterThreshold, excludeTags }
}

// 标签输入 → 标签数组：接受整段文本或数组，逗号/换行/分号分隔，去空去重（保序）
export function parseTagText(input: string | string[]): string[] {
  const txt = Array.isArray(input) ? input.join(', ') : input
  const seen = new Set<string>()
  const tags: string[] = []
  for (const raw of txt.split(/[,;\n]/)) {
    const tag = raw.trim()
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
  }
  return tags
}

function isItemId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)
}

// 单图打标：推理 → 写 image/<id>.txt → 更新 sidecar meta
async function tagOne(
  runner: Runner,
  folder: string,
  id: string,
  modelId: Wd14ModelId,
  options: TagOptions,
): Promise<{ tags: string[]; rating: string }> {
  const dir = join(runner.dataDir, 'capture', folder)
  const file = join(dir, 'image', `${id}.jpg`)
  if (!existsSync(file)) throw new RunnerError(`image not found: ${folder}/${id}`, 404)
  const ses = await loadSession(modelsDirOf(runner), modelId, log)
  const result = await tagFile(file, ses, options)
  const meta = readMeta(dir, id) ?? { id, folder }
  writeMeta(dir, id, {
    ...meta,
    tags: result.tags,
    tagRating: result.rating,
    tagger: modelId,
    tagThreshold: options.generalThreshold ?? 0.35,
    tagCharThreshold: options.characterThreshold ?? 0.85,
    tagError: null,
    taggedAt: runner.now().toISOString(),
  })
  writeFileSync(join(dir, 'image', `${id}.txt`), result.tags.join(', '), 'utf8')
  return result
}

async function runJob(
  runner: Runner,
  job: TagJob,
  ids: string[],
  options: TagOptions,
): Promise<void> {
  const dir = join(runner.dataDir, 'capture', job.folder)
  try {
    await loadSession(modelsDirOf(runner), job.modelId, log)
    job.status = 'running'
    for (const id of ids) {
      try {
        await tagOne(runner, job.folder, id, job.modelId, options)
        job.done += 1
      } catch (err) {
        job.failed += 1
        const meta = readMeta(dir, id) ?? { id, folder: job.folder }
        writeMeta(dir, id, { ...meta, tagError: messageOf(err) })
        log(`failed ${job.folder}/${id}: ${messageOf(err)}`)
      }
    }
    job.status = 'done'
  } catch (err) {
    job.status = 'error'
    job.error = messageOf(err)
    log(`job ${job.folder} error: ${messageOf(err)}`)
  } finally {
    job.finishedAt = runner.now().toISOString()
  }
}

// 待打标 id：image/ 下的 jpg，未标过的优先；force 时全量重打
function pendingIds(runner: Runner, folder: string, force: boolean): string[] {
  const dir = join(runner.dataDir, 'capture', folder)
  const imageDir = join(dir, 'image')
  const ids: string[] = []
  for (const file of readdirSync(imageDir)) {
    if (!file.endsWith('.jpg')) continue
    const id = file.slice(0, -4)
    if (!force) {
      const meta = readMeta(dir, id)
      if (Array.isArray(meta?.tags)) continue
    }
    ids.push(id)
  }
  return ids
}

export function mountTag(app: Hono, runner: Runner): void {
  // 模型与任务总览
  app.get('/tag/status', (c) => {
    return c.json({
      defaultModel: DEFAULT_WD14_MODEL,
      models: Object.entries(WD14_MODELS).map(([id, meta]) => ({
        id,
        repo: meta.repo,
        size: meta.size,
        cached: isModelCached(modelsDirOf(runner), id as Wd14ModelId),
        loaded: isModelLoaded(id as Wd14ModelId),
      })),
      jobs: [...jobs.values()],
    })
  })

  // 任务进度：不传 folder 给全部，传了给单个（可能为 null）
  app.get('/tag/job', (c) => {
    const folder = c.req.query('folder') ?? ''
    if (folder === '') return c.json({ jobs: [...jobs.values()] })
    return c.json({ job: jobs.get(folder) ?? null })
  })

  // folder 批量打标（后台逐张，202 即回；同 folder 并发任务 409）
  app.post('/tag/folder', async (c) => {
    const body = await jsonObject(c.req)
    const folder = stringField(body, 'folder')
    if (!isFolderName(folder)) throw new RunnerError('invalid folder name')
    const dir = join(runner.dataDir, 'capture', folder)
    if (!existsSync(join(dir, 'image'))) {
      throw new RunnerError(`folder not found: ${folder}`, 404)
    }
    const modelId = modelIdOf(body)
    const options = optionsOf(body)
    const force = body.force === true

    const existing = jobs.get(folder)
    if (existing && (existing.status === 'loading' || existing.status === 'running')) {
      throw new RunnerError(`tag job already running for folder: ${folder}`, 409)
    }

    const ids = pendingIds(runner, folder, force)
    if (ids.length === 0) {
      return c.json({ folder, queued: 0, status: 'done' as const })
    }
    const job: TagJob = {
      folder,
      modelId,
      total: ids.length,
      done: 0,
      failed: 0,
      status: 'loading',
      error: null,
      startedAt: runner.now().toISOString(),
      finishedAt: null,
    }
    jobs.set(folder, job)
    void runJob(runner, job, ids, options)
    return c.json({ folder, queued: ids.length, model: modelId, status: 'loading' }, 202)
  })

  // 单图重打标（同步返回；模型未就位时该请求会先触发下载/加载，可能较慢）
  app.post('/tag/item', async (c) => {
    const body = await jsonObject(c.req)
    const folder = stringField(body, 'folder')
    const id = stringField(body, 'id')
    if (!isFolderName(folder)) throw new RunnerError('invalid folder name')
    if (!isItemId(id)) throw new RunnerError('invalid id')
    const modelId = modelIdOf(body)
    const options = optionsOf(body)
    const result = await tagOne(runner, folder, id, modelId, options)
    return c.json({ folder, id, tags: result.tags, rating: result.rating })
  })

  // 读取单图标签（image/<id>.txt 为真相源；没打过标返回空数组，便于直接手动编辑）
  app.get('/tag/item', (c) => {
    const folder = c.req.query('folder') ?? ''
    const id = c.req.query('id') ?? ''
    if (!isFolderName(folder)) throw new RunnerError('invalid folder name')
    if (!isItemId(id)) throw new RunnerError('invalid id')
    const dir = join(runner.dataDir, 'capture', folder)
    const txtFile = join(dir, 'image', `${id}.txt`)
    const meta = readMeta(dir, id)
    const tags = existsSync(txtFile) ? parseTagText(readFileSync(txtFile, 'utf8')) : []
    return c.json({
      folder,
      id,
      tags,
      rating: typeof meta?.tagRating === 'string' ? meta.tagRating : null,
      tagger: typeof meta?.tagger === 'string' ? meta.tagger : null,
      edited: meta?.tagSource === 'manual',
    })
  })

  // 保存编辑后的标签：写 txt + meta（tagSource=manual，后续批量 force 才会被覆盖）
  app.put('/tag/item', async (c) => {
    const body = await jsonObject(c.req)
    const folder = stringField(body, 'folder')
    const id = stringField(body, 'id')
    if (!isFolderName(folder)) throw new RunnerError('invalid folder name')
    if (!isItemId(id)) throw new RunnerError('invalid id')
    if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string')) {
      throw new RunnerError('tags must be string[]')
    }
    const tags = parseTagText(body.tags as string[])
    const dir = join(runner.dataDir, 'capture', folder)
    if (!existsSync(join(dir, 'image', `${id}.jpg`))) {
      throw new RunnerError(`image not found: ${folder}/${id}`, 404)
    }
    const meta = readMeta(dir, id) ?? { id, folder }
    writeMeta(dir, id, {
      ...meta,
      tags,
      tagSource: 'manual',
      tagEditedAt: runner.now().toISOString(),
    })
    writeFileSync(join(dir, 'image', `${id}.txt`), tags.join(', '), 'utf8')
    return c.json({ folder, id, tags: tags.length })
  })
}
