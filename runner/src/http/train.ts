import type { Hono } from 'hono'

import { assetById, type ImageAsset } from '../capture/asset.ts'
import { findRepoRoot } from '../config.ts'
import { listDatasets } from '../dataset/records.ts'
import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'
import {
  DEFAULT_BASE_MODEL,
  buildPairs,
  characterNames,
  dirNameOf,
  jobNameOf,
  loadProfiles,
  pickDataset,
  stagePairs,
  trainOverridesOf,
  uploadPairs,
  type ProfileBook,
  type TrainProfile,
} from '../train/fromDataset.ts'
import { jsonObject } from './request.ts'

// 训练发起台：
//   POST /train/jobs    低层——只认训练机上已存在的 datasetPath，其余用稳定档预设补全。
//   POST /train/start   高层——选数据集 + 触发词 + profile，服务端导出、上传、建 job，
//                       等价于 export_dataset.mjs + train_animagine.mjs --train-only。
// 其余 /train/* 纯代理到训练机 trainer（:8788）。字段校验以 trainer 为准。

// SDXL 风格 LoRA 稳定档（2026-11-17 定案：bf16/unet_only/TE cache，速度 2.2s/it）。
// 调用方只须给 name + datasetPath，其余按需覆盖。
const STABLE_PRESET: Record<string, unknown> = {
  datasetRoot: 'training',
  baseModel: 'checkpoints/pdv10.safetensors',
  resolution: 1024,
  batchSize: 1,
  numRepeats: 10,
  networkDim: 128,
  networkAlpha: 32,
  unetLr: 0.0004,
  textEncoderLr: 0.00005,
  scheduler: 'constant',
  lrWarmupSteps: 100,
  maxTrainEpochs: 3,
  saveEveryNEpochs: 1,
  clipSkip: 2,
  minSnrGamma: 5,
  sdpa: true,
  unetOnly: true,
  sdxl: true,
  shuffleCaption: false,
  cacheTextEncoderOutputs: true,
  keepTokens: 0,
}

export type TrainMountOptions = {
  // 测试注入；生产从 <repoRoot>/scripts_and_tools/train_profiles.json 读。
  profiles?: ProfileBook
}

function trainerOf(runner: Runner): string {
  if (!runner.trainerBaseURL) {
    throw new RunnerError(
      'trainer not configured: set runner.trainerBaseURL in config.json',
      503,
    )
  }
  return runner.trainerBaseURL
}

async function proxy(
  runner: Runner,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const base = trainerOf(runner)
  let res: Response
  try {
    res = await fetch(`${base}${path}`, init)
  } catch (err) {
    throw new RunnerError(
      `trainer unreachable at ${base}: ${err instanceof Error ? err.message : String(err)}`,
      502,
    )
  }
  const text = await res.text()
  return new Response(text, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  })
}

function profilesOf(runner: Runner, options: TrainMountOptions): ProfileBook {
  if (options.profiles) return options.profiles
  return loadProfiles(findRepoRoot([runner.dataDir, process.cwd()]))
}

function profileOf(
  runner: Runner,
  options: TrainMountOptions,
  name: string,
): TrainProfile {
  const book = profilesOf(runner, options)
  const profile = book[name]
  if (!profile) {
    throw new RunnerError(
      `未知 profile: ${name}（可用：${Object.keys(book).join(', ')}）`,
    )
  }
  return profile
}

// 稳定档 + 调用方覆盖 → trainer 请求体。建 job 前先让 ComfyUI 交还显存：
// 同一块 3080 上 ComfyUI 常驻模型会把训练挤进共享内存（慢 6 倍）。
async function postTrainJob(
  runner: Runner,
  body: Record<string, unknown>,
): Promise<Response> {
  const freed = await freeComfyMemory(runner)
  const merged = { ...STABLE_PRESET, ...body }
  const res = await proxy(runner, '/train/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(merged),
  })
  const copy = new Response(res.body, {
    status: res.status,
    headers: new Headers(res.headers),
  })
  copy.headers.set('x-comfy-free', freed)
  return copy
}

async function freeComfyMemory(runner: Runner): Promise<string> {
  const client = runner.clients[0]
  if (!client) return 'no-comfy'
  try {
    await client.freeMemory()
    return 'freed'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return `skip: ${message.slice(0, 120)}`
  }
}

export function mountTrain(
  app: Hono,
  runner: Runner,
  options: TrainMountOptions = {},
): void {
  app.post('/train/jobs', async (c) => {
    const body = await jsonObject(c.req)
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      throw new RunnerError('name is required')
    }
    if (typeof body.datasetPath !== 'string' || body.datasetPath.trim() === '') {
      throw new RunnerError('datasetPath is required')
    }
    return postTrainJob(runner, body)
  })

  app.get('/train/jobs', (c) => proxy(runner, '/train/jobs'))

  app.get('/train/jobs/:id', (c) =>
    proxy(runner, `/train/jobs/${c.req.param('id')}`),
  )

  app.get('/train/jobs/:id/log', (c) =>
    proxy(runner, `/train/jobs/${c.req.param('id')}/log`),
  )

  app.delete('/train/jobs/:id', (c) =>
    proxy(runner, `/train/jobs/${c.req.param('id')}`, { method: 'DELETE' }),
  )

  app.get('/train/profiles', (c) => {
    const book = profilesOf(runner, options)
    return c.json({
      profiles: Object.entries(book).map(([name, profile]) => ({
        name,
        desc: profile.desc,
        expectImages: profile.expectImages ?? null,
        params: profile.params,
      })),
      preset: STABLE_PRESET,
      defaultBaseModel: DEFAULT_BASE_MODEL,
    })
  })

  // body: { dataset, trigger?, profile?, stripCharacters?, baseModel?, params?, dryRun?, concurrency?, name? }
  app.post('/train/start', async (c) => {
    const body = await jsonObject(c.req)
    if (typeof body.dataset !== 'string' || body.dataset.trim() === '') {
      throw new RunnerError('dataset is required')
    }
    const trigger = typeof body.trigger === 'string' ? body.trigger.trim() : ''
    const profileName =
      typeof body.profile === 'string' && body.profile.trim() !== ''
        ? body.profile.trim()
        : 'seed'
    const profile = profileOf(runner, options, profileName)

    const params: Record<string, unknown> = {
      ...profile.params,
      ...trainOverridesOf(body.params),
    }
    // 触发词给了就锁 caption 首 token（训练时 keepTokens=1）。
    if (trigger) params.keepTokens = 1
    if ((params.cacheTextEncoderOutputs ?? true) && (params.shuffleCaption ?? false)) {
      throw new RunnerError(
        'cacheTextEncoderOutputs 与 shuffleCaption 互斥：开 shuffle 需同时设 false',
      )
    }

    const datasets = listDatasets(runner.db)
    const dataset = pickDataset(datasets, body.dataset.trim())
    if (!dataset) {
      throw new RunnerError(
        `没找到数据集 ${body.dataset}（现有：${datasets.map((d) => d.name).join(', ') || '无'}）`,
        404,
      )
    }
    if (dataset.assetIds.length === 0) {
      throw new RunnerError(`数据集 ${dataset.name} 是空的`)
    }

    const characters =
      body.stripCharacters === true ? characterNames(runner.dataDir) : undefined
    const assets = dataset.assetIds
      .map((id) => assetById(runner.db, id))
      .filter((asset): asset is ImageAsset => asset !== null)
    const { pairs, skipped } = buildPairs(assets, {
      dataDir: runner.dataDir,
      trigger,
      ...(characters ? { characters } : {}),
    })
    if (pairs.length === 0) {
      throw new RunnerError(
        `数据集 ${dataset.name} 没有可导出的图（缺 processed 版本或 tags）：${skipped.slice(0, 3).join('; ')}`,
      )
    }

    const dirName = dirNameOf(dataset.name)
    const baseModel =
      typeof body.baseModel === 'string' && body.baseModel.trim() !== ''
        ? body.baseModel.trim()
        : DEFAULT_BASE_MODEL
    const name =
      typeof body.name === 'string' && body.name.trim() !== ''
        ? body.name.trim()
        : jobNameOf(dirName, profileName, runner.now())

    const [lo, hi] = profile.expectImages ?? []
    const warn =
      lo !== undefined && (pairs.length < lo || pairs.length > hi!)
        ? `profile ${profileName} 预期 ${lo}-${hi} 图，实际 ${pairs.length} 图`
        : null
    const steps =
      pairs.length *
      Number(params.numRepeats ?? 10) *
      Number(params.maxTrainEpochs ?? 3)

    if (body.dryRun === true) {
      return c.json({
        dryRun: true,
        dataset: dataset.name,
        dirName,
        profile: profileName,
        images: pairs.length,
        skipped,
        warn,
        steps,
        name,
        params,
        sample: pairs[0]?.caption.slice(0, 200) ?? null,
      })
    }

    const stagingDir = stagePairs(runner.dataDir, dirName, pairs)
    const { pushed, failures } = await uploadPairs(
      trainerOf(runner),
      dirName,
      stagingDir,
      pairs,
      Math.max(1, Number(body.concurrency) || 4),
    )
    if (failures.length) {
      throw new RunnerError(
        `${failures.length} 个文件上传失败：${failures.slice(0, 3).join('; ')}`,
        502,
      )
    }

    const res = await postTrainJob(runner, {
      name,
      datasetRoot: 'training',
      datasetPath: `${dirName}/img`,
      baseModel,
      ...params,
    })
    const text = await res.text()
    if (!res.ok) {
      return new Response(text, {
        status: res.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    return c.json(
      {
        ...(JSON.parse(text) as Record<string, unknown>),
        dataset: dataset.name,
        dirName,
        profile: profileName,
        images: pairs.length,
        pushed,
        skipped,
        warn,
        steps,
        staging: stagingDir,
        params,
        comfyFree: res.headers.get('x-comfy-free') ?? 'unknown',
      },
      201,
    )
  })
}
