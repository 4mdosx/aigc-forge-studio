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
import { TIERS, normalizeTier } from '../train/captionTiers.ts'
import {
  artifactCandidates,
  findRetrievedByJobId,
  initialState,
  readManifest,
  retrieveArtifacts,
  safeJobName,
  type RetrieveState,
} from '../train/retrieve.ts'
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

// 产物回程是分钟级的大文件传输，不能让 POST 等到传完；进程内存记状态，
// 落盘的 manifest.json 才是「已回程」真相源（runner 重启后靠它找回）。
const retrieves = new Map<string, RetrieveState>()

async function syncFromDisk(runner: Runner, jobId: string): Promise<RetrieveState> {
  const current = retrieves.get(jobId)
  if (current && current.status !== 'idle') {
    if (current.status === 'done' && current.name) {
      const manifest = await readManifest(runner.dataDir, current.name)
      if (manifest?.jobId === jobId && manifest.files.length) return current
      const fresh = initialState(jobId)
      retrieves.set(jobId, fresh)
      return fresh
    }
    return current
  }
  const found = await findRetrievedByJobId(runner.dataDir, jobId)
  if (!found) return current ?? initialState(jobId)
  const done: RetrieveState = {
    ...initialState(jobId),
    name: found.name,
    status: 'done',
    phase: '已回程',
    done: found.manifest.files.length,
    total: found.manifest.files.length,
    files: found.manifest.files,
    finishedAt: found.manifest.deployedAt,
    localDir: `data/lora/${found.name}`,
  }
  retrieves.set(jobId, done)
  return done
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
  // trainer 路由不存在时（旧进程）404 会把「没这条路由」和「查不到这条记录」混在一起，
  // 调用方只能靠 body 区分：路由缺失是 {"error":"not found"}，记录缺失会带业务措辞。
  staleHint?: string,
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
  if (staleHint && res.status === 404 && text.includes('"not found"')) {
    return Response.json({ error: staleHint }, { status: 503 })
  }
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

  // 试运行：同一套预设合并与校验，但不占显存、不建 job。
  // 不走 postTrainJob——preview 不该顺手清 ComfyUI 显存。
  app.post('/train/jobs/preview', async (c) => {
    const body = await jsonObject(c.req)
    const merged = { ...STABLE_PRESET, ...body }
    return proxy(
      runner,
      '/train/jobs/preview',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(merged),
      },
      '训练机 trainer 没有 preview 路由（进程仍是旧版本）：在训练机执行 git pull 后 infra\\trainer_service.ps1 restart',
    )
  })

  app.get('/train/jobs', (c) => proxy(runner, '/train/jobs'))

  app.get('/train/jobs/:id', (c) =>
    proxy(runner, `/train/jobs/${c.req.param('id')}`),
  )

  app.get('/train/jobs/:id/log', (c) => {
    // tail 等查询参数原样透传（训练页只拉日志尾巴算进度）
    const search = new URL(c.req.url).search
    return proxy(runner, `/train/jobs/${c.req.param('id')}/log${search}`)
  })

  // 产物回程：POST 启动后台传输并立即返回；GET 查状态（首屏靠 manifest 反查）。
  app.get('/train/jobs/:id/retrieve', async (c) =>
    c.json(await syncFromDisk(runner, c.req.param('id'))),
  )

  app.post('/train/jobs/:id/retrieve', async (c) => {
    const jobId = c.req.param('id')
    const detail = await proxy(runner, `/train/jobs/${encodeURIComponent(jobId)}`)
    if (!detail.ok) return detail
    const payload = (await detail.json()) as Record<string, unknown>
    // trainer 详情有的版本包一层 { job: ... }，有的直接是 job 对象。
    const job = ((payload.job ?? payload) ?? {}) as Record<string, unknown>
    if (job.status !== 'completed') {
      throw new RunnerError('只有已完成的任务才能回程产物')
    }
    const params = (job.params ?? {}) as Record<string, unknown>

    // 先按 jobId 查盘：旧脚本的 manifest.name 可能和 trainer job.name 不同
    // （训练名带触发词、job 名不带），只看同名会误判成未回程再拉 1GB。
    const found = await findRetrievedByJobId(runner.dataDir, jobId)
    if (found) {
      const done: RetrieveState = {
        ...initialState(jobId),
        name: found.name,
        status: 'done',
        phase: '已回程',
        done: found.manifest.files.length,
        total: found.manifest.files.length,
        files: found.manifest.files,
        finishedAt: found.manifest.deployedAt,
        localDir: `data/lora/${found.name}`,
      }
      retrieves.set(jobId, done)
      return c.json(done)
    }

    const name = safeJobName(job.name)

    const running = retrieves.get(jobId)
    if (running?.status === 'running') return c.json(running, 202)

    const state: RetrieveState = {
      ...initialState(jobId),
      name,
      status: 'running',
      phase: '准备中',
      startedAt: runner.now().toISOString(),
      total: artifactCandidates(params, name).length,
      localDir: `data/lora/${name}`,
    }
    retrieves.set(jobId, state)

    void (async () => {
      try {
        const manifest = await retrieveArtifacts({
          trainerBaseURL: trainerOf(runner),
          dataDir: runner.dataDir,
          jobId,
          name,
          params,
          onProgress: (phase, done, total) => {
            state.phase = phase
            state.done = done
            state.total = total
          },
        })
        state.status = 'done'
        state.phase = '已回程'
        state.done = manifest.files.length
        state.total = manifest.files.length
        state.files = manifest.files
        state.finishedAt = runner.now().toISOString()
      } catch (err) {
        state.status = 'error'
        state.phase = '回程失败'
        state.error = err instanceof Error ? err.message : String(err)
        state.finishedAt = runner.now().toISOString()
        console.error(`[train] 回程 ${jobId} 失败: ${state.error}`)
      }
    })()

    return c.json(state, 202)
  })

  for (const action of ['pause', 'resume'] as const) {
    app.post(`/train/jobs/:id/${action}`, (c) =>
      proxy(
        runner,
        `/train/jobs/${c.req.param('id')}/${action}`,
        { method: 'POST' },
        `训练机 trainer 没有 ${action} 路由（进程仍是旧版本）：在训练机执行 git pull 后 infra\\trainer_service.ps1 restart`,
      ),
    )
  }

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
      captionTiers: Object.values(TIERS),
    })
  })

  // body: { dataset, trigger?, profile?, tier?, styleTags?, stripCharacters?, baseModel?, params?, dryRun?, concurrency?, name? }
  // tier = T0 纯风格 / T1 设计语言 / T2 概念题材 / T3 角色身份；留空 = 原样（旧行为）。
  app.post('/train/start', async (c) => {
    const body = await jsonObject(c.req)
    if (typeof body.dataset !== 'string' || body.dataset.trim() === '') {
      throw new RunnerError('dataset is required')
    }
    let tier: ReturnType<typeof normalizeTier>
    try {
      tier = normalizeTier(body.tier)
    } catch (err) {
      throw new RunnerError(err instanceof Error ? err.message : String(err))
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

    // 角色名始终剥：除非在训角色 LoRA（那种用触发词指定身份，不靠 tag）。
    // 词表缺失时降级为空集，别让无 tagger 的环境建不了 job。
    const characters = characterNames(runner.dataDir, false)
    const styleTags = typeof body.styleTags === 'string'
      ? body.styleTags.split(',').map((s) => s.trim()).filter(Boolean)
      : Array.isArray(body.styleTags)
        ? body.styleTags.map((s) => String(s).trim()).filter(Boolean)
        : []
    const assets = dataset.assetIds
      .map((id) => assetById(runner.db, id))
      .filter((asset): asset is ImageAsset => asset !== null)
    const { pairs, skipped } = buildPairs(assets, {
      dataDir: runner.dataDir,
      trigger,
      tier,
      styleTags,
      characters,
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
        : jobNameOf(dirName, trigger, profileName, runner.now())

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
        tier: tier ?? 'raw',
        styleTags,
        sample: pairs[0]?.caption.slice(0, 200) ?? null,
      })
    }

    const stagingDir = stagePairs(runner.dataDir, dirName, pairs)
    const { pushed, failures, pruned } = await uploadPairs(
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
      // 声明式期望值：训练机若还有旧图（sync 没清掉或旧版 trainer），直接 409
      expectedImages: pairs.length,
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
        tier: tier ?? 'raw',
        images: pairs.length,
        pushed,
        pruned,
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
