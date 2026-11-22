#!/usr/bin/env node
// 把导出的数据集推到训练机，以 Animagine XL 4.0 Zero 为底模启动 LoRA 训练，
// 并默认接着跑完「回流 → ComfyUI 可见 → 验证矩阵 + 拼图」全流程。
//   node scripts_and_tools/train_animagine.mjs --dry-run                       # 只看参数，不动服务
//   node scripts_and_tools/train_animagine.mjs --list-profiles                # 列出全部 profile
//   node scripts_and_tools/train_animagine.mjs --dataset style-fullbody --profile seed --trigger zzstyle
//       ↑ 一条命令：建 job → 等完成 → 拉 checkpoint 到 data/lora/<job>/ → 推 models/loras →
//         确认 ComfyUI 可见 → 跑 verify_ax4z_lora.mjs 矩阵 → 出 compare_grid 拼图
//   node scripts_and_tools/train_animagine.mjs --attach <jobId> --dataset mech_man --trigger zxmechman
//       ↑ 接管一个已在跑/已完成的 job，只做后半段，不重训
//   node scripts_and_tools/train_animagine.mjs ... --train-only                # 旧行为：只建 job
//   node scripts_and_tools/train_animagine.mjs ... --no-verify                 # 回流但不跑验证
//
// 数据源：data/training-export/<dataset>/img（由 export_dataset.mjs 产出）。
// 落点：训练机 C:\AIGC\training\<dataset>\img，底模 C:\AIGC\models\checkpoints\animagine-xl-4.0-zero.safetensors。
// 训练参数：profile 只写与 runner STABLE_PRESET 的差异项；runner 会 merge（{...preset, ...body}）。
// 建 job 必须走 runner :8787 自动吃快档（TE cache 开 / shuffle 关，2.0~2.6 s/it）；
// 直连 trainer :8788 会吃到原始慢档（~14.5 s/it）。检查产物/日志/下载走 trainer :8788。

import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    dataset: { type: 'string' },
    profile: { type: 'string', default: 'seed' },
    trigger: { type: 'string', default: '' },
    set: { type: 'string', multiple: true, default: [] },
    'dry-run': { type: 'boolean', default: false },
    'list-profiles': { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '4' },
    attach: { type: 'string' },
    'train-only': { type: 'boolean', default: false },
    'no-verify': { type: 'boolean', default: false },
    'poll-seconds': { type: 'string', default: '20' },
    'timeout-hours': { type: 'string', default: '6' },
  },
})

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const config = JSON.parse(readFileSync(join(repoRoot, 'config.json'), 'utf8'))
const trainerBase = String(
  config.runner?.trainerBaseURL ?? 'http://192.168.8.136:8788',
).replace(/\/$/, '')
const comfyBase = String(
  config.comfyui?.baseURL ?? 'http://192.168.8.136:8188',
).replace(/\/$/, '')
const runnerBase = `http://127.0.0.1:${config.runner?.port ?? 8787}`
const BASE_MODEL = 'checkpoints/animagine-xl-4.0-zero.safetensors'

const profilesDoc = JSON.parse(
  readFileSync(join(scriptDir, 'train_profiles.json'), 'utf8'),
)
const profiles = profilesDoc.profiles

// trainer/src/train/toml.ts 接受的训练字段。白名单挡拼写错误，避免静默吃掉覆盖。
const ALLOWED_PARAMS = [
  'resolution', 'batchSize', 'numRepeats', 'networkDim', 'networkAlpha',
  'unetLr', 'textEncoderLr', 'scheduler', 'lrWarmupSteps', 'maxTrainEpochs',
  'saveEveryNEpochs', 'clipSkip', 'minSnrGamma', 'sdpa', 'unetOnly', 'sdxl',
  'cacheTextEncoderOutputs', 'shuffleCaption', 'keepTokens', 'samplePrompts',
  'sampleEveryNEpochs',
]

function coerce(raw) {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw !== '' && Number.isFinite(Number(raw))) return Number(raw)
  return raw
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (values['list-profiles']) {
  console.log('训练 profile（train_profiles.json）——只列差异项，其余继承 runner STABLE_PRESET\n')
  for (const [name, p] of Object.entries(profiles)) {
    console.log(`  ${name.padEnd(11)} ${p.desc}`)
    console.log(`  ${' '.repeat(11)} ${Object.entries(p.params).map(([k, v]) => `${k}=${v}`).join('  ')}\n`)
  }
  console.log('用法：--profile <name> [--set key=value ...] [--trigger <word>] [--attach <jobId>] [--train-only] [--dry-run]')
  process.exit(0)
}

const attaching = Boolean(values.attach)
const profile = profiles[values.profile]
if (!attaching && !profile) {
  console.error(
    `未知 profile: ${values.profile}\n可用：${Object.keys(profiles).join(', ')}\n用 --list-profiles 看详情。`,
  )
  process.exit(1)
}

const overrides = {}
for (const item of values.set) {
  const i = item.indexOf('=')
  if (i < 1) {
    console.error(`--set 格式要 key=value，收到: ${item}`)
    process.exit(1)
  }
  const key = item.slice(0, i).trim()
  if (!ALLOWED_PARAMS.includes(key)) {
    console.error(`未知训练参数: ${key}\n可用：${ALLOWED_PARAMS.join(', ')}`)
    process.exit(1)
  }
  overrides[key] = coerce(item.slice(i + 1).trim())
}
const params = attaching ? {} : { ...profile.params, ...overrides }
// 触发词传了就锁住 caption 首个 token；没传时尊重 profile 的设置。
if (values.trigger.trim()) params.keepTokens = 1
// runner preset 默认 cacheTextEncoderOutputs=true，必须把继承值算进互斥检查。
if ((params.cacheTextEncoderOutputs ?? true) && (params.shuffleCaption ?? false)) {
  console.error(
    'cacheTextEncoderOutputs 与 shuffleCaption 互斥（trainer 会拒绝）。' +
      'runner 快档默认 cache=on；要开 shuffle 得同时 --set cacheTextEncoderOutputs=false。',
  )
  process.exit(1)
}

if (!values.dataset) {
  console.error('需要 --dataset <名字>（export_dataset.mjs 导出的目录名；--attach 时也用它读 caption 取触发词）')
  process.exit(1)
}
const dirName = values.dataset.replace(/[^\w.-]+/g, '-')
const imageDir = join(repoRoot, 'data', 'training-export', dirName, 'img')
try {
  statSync(imageDir)
} catch {
  console.error(`没有导出目录：${imageDir}\n先跑 export_dataset.mjs`)
  process.exit(1)
}

const images = readdirSync(imageDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
const pairs = images
  .map((image) => {
    const stem = image.replace(/\.[^.]+$/, '')
    const caption = join(imageDir, `${stem}.txt`)
    return existsFile(caption) ? { image, stem, caption } : null
  })
  .filter(Boolean)
function existsFile(p) {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}
if (pairs.length === 0) {
  console.error(`没有带 caption 的图片：${imageDir}`)
  process.exit(1)
}

// 触发词要早于建 job 拿到：它已经进 LoRA 名字里了，不能等到收尾段才算。
const trigger = values.trigger.trim() || firstTokenOf(pairs[0].caption)
if (!trigger) {
  console.error('拿不到触发词。传 --trigger <word>，或检查 caption 第一行。')
  process.exit(1)
}

// 命名：<数据集>-<触发词>-<profile>-az-<YYMMDD-HMM>
// 触发词进名字：同名数据集换触发词重训出的 LoRA 一眼能分，ComfyUI 下拉里也不会两条同名。
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(2, 12).replace('T', '-')
const jobName = `${dirName}-${trigger}-${values.profile}-az-${stamp}`
  .toLowerCase()
  .replace(/[^a-z0-9_-]/g, '-')
  .replace(/-+/g, '-')

if (!attaching) {
  const repeats = params.numRepeats ?? 10
  const epochs = params.maxTrainEpochs ?? 3
  const steps = pairs.length * repeats * epochs
  const [lo, hi] = profile.expectImages ?? []
  if (pairs.length < lo || pairs.length > hi) {
    console.warn(
      `警告：profile ${values.profile} 预期 ${lo}-${hi} 图，实际 ${pairs.length} 图。用错 profile 会改变曝光密度。`,
    )
  }
  console.log(`profile  ${values.profile} — ${profile.desc}`)
  console.log(`数据集  ${dirName}：${pairs.length}/${images.length} 组 image+caption`)
  console.log('参数覆盖（其余继承 runner STABLE_PRESET）：')
  for (const [k, v] of Object.entries(params)) console.log(`  ${k.padEnd(26)} ${v}`)
  console.log(
    `估算  ${pairs.length} 图 × ${repeats} repeats × ${epochs} epochs = ${steps} step` +
      `（@2s/it ≈ ${Math.round(steps * 2 / 60)} min）`,
  )
} else {
  console.log(`接管模式：job ${values.attach}（不重新上传、不新建 job）`)
  console.log(`数据集  ${dirName}：${pairs.length}/${images.length} 组 image+caption（仅用于触发词与 step 估算）`)
}
if (values['dry-run']) {
  if (!attaching) console.log(`\n名字预告  ${jobName}`)
  if (!attaching) await previewOnTrainer(dirName, pairs.length, params)
  console.log('[dry-run] 未上传、未建 job、未回流、未验证。')
  process.exit(0)
}

let job
if (attaching) {
  job = await fetchJson(`${trainerBase}/train/jobs/${values.attach}`)
  console.log(`\njob ${job.id}  name=${job.name}  status=${job.status}`)
} else {
  // 底模检查：下载未完成时给出明确提示，别让训练 job 在启动后才失败。
  const downloads = await fetchJson('/downloads')
  const modelDownloads = downloads.downloads.filter(
    (d) => d.root === 'models' && d.path === BASE_MODEL,
  )
  // 同一 path 可能留下 cancelled 的旧任务（换下载源时），优先认 completed。
  const modelDownload =
    modelDownloads.find((d) => d.status === 'completed') ?? modelDownloads.at(-1)
  if (modelDownload?.status === 'failed') {
    console.error(`底模下载失败：${modelDownload.error}`)
    process.exit(1)
  }
  if (!modelDownload || modelDownload.status !== 'completed') {
    console.warn(
      `警告：底模下载状态 ${modelDownload?.status ?? '未提交'}，训练可能启动失败。`,
    )
  }

  const concurrency = Math.max(1, Number(values.concurrency) || 4)
  // /upload 的 path 相对 root，不带 root 名（带 training/ 会落到 training\training）
  const target = `${dirName}/img`
  await syncDataset(target, pairs)
  console.log(`\n推送 ${pairs.length} 组 → ${trainerBase}`)
  let done = 0
  const errors = []
  async function upload(path, bytes) {
    const url = `${trainerBase}/upload?root=training&path=${encodeURIComponent(path)}`
    const res = await fetch(url, { method: 'POST', body: bytes })
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`)
  }
  const workers = Array.from({ length: Math.min(concurrency, pairs.length) }, async (_, i) => {
    for (let n = i; n < pairs.length; n += concurrency) {
      const p = pairs[n]
      try {
        await upload(`${target}/${p.image}`, readFileSync(join(imageDir, p.image)))
        await upload(`${target}/${p.stem}.txt`, readFileSync(p.caption))
        done += 1
        if (done % 5 === 0) console.log(`  ${done}/${pairs.length}`)
      } catch (err) {
        errors.push(err.message)
        console.error(`FAIL ${err.message}`)
      }
    }
  })
  await Promise.all(workers)
  if (errors.length) {
    console.error(`${errors.length} 个文件上传失败`)
    process.exit(1)
  }
  console.log(`已推 ${done} 组到 ${target}`)

  // 命名：<数据集>-<触发词>-<profile>-az-<YYMMDD-HMM>（上面 jobName 算好，这里只引用）
  const name = jobName
  const body = {
    name,
    datasetRoot: 'training',
    datasetPath: `${dirName}/img`,
    baseModel: BASE_MODEL,
    // 声明式期望值：训练机上若还剩旧图，trainer 直接 409，不用等跑完才发现步数不对
    expectedImages: pairs.length,
    ...params,
  }
  const created = await fetchJson(`${runnerBase}/train/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  job = created.job
  console.log(`\n训练 job：${job.id}  name=${name}  status=${job.status}`)
  console.log(`  curl ${trainerBase}/train/jobs/${job.id}`)
  console.log(`  curl ${trainerBase}/train/jobs/${job.id}/log`)
}

if (values['train-only']) {
  console.log('\n[train-only] 就到这里。完成后手工跑：')
  console.log(`  node ${join(scriptDir, 'train_animagine.mjs')} --attach ${job.id} --dataset ${dirName} --trigger <触发词>`)
  process.exit(0)
}

console.log(`\n触发词（验证时锁首位）：${trigger}`)
console.log('[post] 进入自动收尾：等训练 → 回流 → 可见性 → 验证 → 拼图')

try {
  await finalize(job, { trigger, stepsPerEpoch: pairs.length * Number(job.params?.numRepeats ?? 10) })
} catch (err) {
  console.error(`\n[post] 失败：${err.message}`)
  process.exit(1)
}

function firstTokenOf(captionPath) {
  const line = readFileSync(captionPath, 'utf8').split('\n')[0] ?? ''
  return line.split(',')[0].trim()
}

function filesUrl(root, path) {
  return `${trainerBase}/files?root=${root}&path=${encodeURIComponent(path)}`
}

async function waitForJob(id) {
  const interval = Math.max(3, Number(values['poll-seconds']) || 20) * 1000
  const deadline = Date.now() + Math.max(1, Number(values['timeout-hours']) || 6) * 3600_000
  let lastStatus = ''
  const started = Date.now()
  while (Date.now() < deadline) {
    const cur = await fetchJson(`${trainerBase}/train/jobs/${id}`)
    if (cur.status !== lastStatus) {
      console.log(`[post] 训练状态 ${lastStatus || '-'} → ${cur.status}`)
      lastStatus = cur.status
    }
    if (['completed', 'failed', 'cancelled'].includes(cur.status)) {
      if (cur.status !== 'completed') {
        throw new Error(`训练 ${cur.status}: ${cur.error ?? ''}`)
      }
      console.log(`[post] 训练完成，耗时 ${Math.round((Date.now() - started) / 60000)} min`)
      return cur
    }
    await sleep(interval)
  }
  throw new Error('等待训练超时（--timeout-hours）')
}

// 声明式对账：先告诉 trainer「这批应该有哪些文件」，让它清掉陈旧的。
// 训练机的上传目录只写不删，复用同一个数据集名时旧图会留在里面，步数被悄悄放大
// （2026-11-22：脚本算 570 步，trainer 按残留的 55 张跑出 1650 步）。
async function syncDataset(target, pairs) {
  const files = pairs.flatMap((p) => [p.image, `${p.stem}.txt`])
  let res
  try {
    res = await fetch(
      `${trainerBase}/sync?root=training&path=${encodeURIComponent(target)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files }),
      },
    )
  } catch (err) {
    console.warn(`[sync] 跳过（trainer 不可达）：${err.message}`)
    return
  }
  const text = await res.text()
  if (res.status === 404) {
    // 两种 404：目录还没建 = 首次训练；{"error":"not found"} = trainer 是旧版本
    const reason = text.includes('path not found')
      ? '目标目录尚未创建（首次训练）'
      : 'trainer 没有 /sync 路由（旧版本，git pull 后重启即可）'
    console.log(`[sync] 跳过清理：${reason}`)
    return
  }
  if (!res.ok) {
    console.warn(`[sync] 失败 HTTP ${res.status}：${text.slice(0, 200)}`)
    return
  }
  const json = JSON.parse(text)
  if (json.deleted?.length) {
    const head = json.deleted.slice(0, 5).join(', ')
    const more = json.deleted.length > 5 ? ' …' : ''
    console.log(`[sync] 清掉 ${json.deleted.length} 个陈旧文件：${head}${more}`)
  } else {
    console.log('[sync] 无陈旧文件')
  }
}

// 真 dry-run：让 trainer 用它那侧的目录算一遍。本地算的是「我打算传什么」，
// trainer 算的是「它现在有什么」——两者不一致正是残留文件的信号。
async function previewOnTrainer(dirName, localCount, params) {
  let res
  try {
    res = await fetch(`${runnerBase}/train/jobs/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: jobName,
        datasetRoot: 'training',
        datasetPath: `${dirName}/img`,
        baseModel: BASE_MODEL,
        ...params,
      }),
    })
  } catch (err) {
    console.log(`[preview] 跳过（runner 不可达）：${err.message}`)
    return
  }
  const text = await res.text()
  if (!res.ok) {
    console.log(`[preview] 跳过：HTTP ${res.status} ${text.slice(0, 160)}`)
    return
  }
  const json = JSON.parse(text)
  const remote = json.stats?.imageCount ?? 0
  const caption = json.stats?.captionCount ?? 0
  console.log(
    `\n[preview] 训练机侧现有 ${remote} 图 / ${caption} caption，预计 ${json.estimatedSteps} 步`,
  )
  if (remote !== localCount) {
    console.warn(
      `          注意：本地准备 ${localCount} 组，训练机上 ${remote} 图。` +
        `提交时会先被 /sync 清成 ${localCount} 组（正是为了不重演 1650 步那次）。`,
    )
  }
}

async function discoverArtifacts(name, epochs, jobId) {
  // 优先问 trainer 要真实产物清单。旧版 trainer 没这个路由，回退到按命名约定猜。
  if (jobId) {
    try {
      const res = await fetch(`${trainerBase}/train/jobs/${jobId}/artifacts`)
      if (res.ok) {
        const json = await res.json()
        const found = (json.artifacts ?? []).map((a) => ({
          file: a.name,
          label: a.epoch === null ? 'final' : `epoch ${a.epoch}`,
        }))
        if (found.length) return found
      }
    } catch {
      // 网络或旧版本：走下面的命名猜测
    }
  }
  const found = []
  for (let i = 1; i <= epochs; i += 1) {
    const file = `${name}-${String(i).padStart(6, '0')}.safetensors`
    if (await existsOnTrainer('training', `${name}/output/${file}`)) {
      found.push({ file, label: `epoch ${i}` })
    }
  }
  const final = `${name}.safetensors`
  if (await existsOnTrainer('training', `${name}/output/${final}`)) {
    found.push({ file: final, label: 'final' })
  }
  if (!found.length) throw new Error(`训练输出目录 ${name}/output 里没找到 safetensors`)
  return found
}

async function existsOnTrainer(root, path) {
  try {
    const res = await fetch(filesUrl(root, path), {
      method: 'HEAD',
      signal: AbortSignal.timeout(10000),
    })
    return res.ok
  } catch {
    return false
  }
}

async function deployArtifacts(name, artifacts) {
  const localDir = join(repoRoot, 'data', 'lora', name)
  mkdirSync(localDir, { recursive: true })
  const manifest = {
    jobId: job.id,
    name,
    baseModel: BASE_MODEL,
    trigger,
    deployedAt: new Date().toISOString(),
    files: [],
  }
  for (const { file } of artifacts) {
    const local = join(localDir, file)
    console.log(`[post] 拉取 ${file} → data/lora/${name}/`)
    const res = await fetch(filesUrl('training', `${name}/output/${file}`))
    if (!res.ok) throw new Error(`拉取 ${file}: HTTP ${res.status}`)
    await pipeline(Readable.fromWeb(res.body), createWriteStream(local))

    console.log(`[post] 推送 ${file} → models/loras/`)
    const up = await fetch(
      `${trainerBase}/upload?root=models&path=${encodeURIComponent(`loras/${file}`)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: createReadStream(local),
        duplex: 'half',
      },
    )
    if (!up.ok) throw new Error(`推送 ${file}: HTTP ${up.status} ${await up.text()}`)
    const info = await up.json()
    manifest.files.push({ file, size: info.size, sha256: info.sha256 })
    console.log(`  ${file}  ${(info.size / 1048576).toFixed(1)} MB  sha256=${info.sha256.slice(0, 12)}…`)
  }
  writeFileSync(join(localDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return localDir
}

async function confirmVisible(files) {
  const [loraInfo, ckptInfo] = await Promise.all([
    fetch(`${comfyBase}/object_info/LoraLoader`, { signal: AbortSignal.timeout(10000) }).then((r) => r.json()),
    fetch(`${comfyBase}/object_info/CheckpointLoaderSimple`, { signal: AbortSignal.timeout(10000) }).then((r) => r.json()),
  ])
  const visible = loraInfo.LoraLoader.input.required.lora_name[0]
  const missing = files.filter((f) => !visible.includes(f.file))
  if (missing.length) {
    throw new Error(`ComfyUI 看不到 LoRA：${missing.map((m) => m.file).join(', ')}`)
  }
  const ckpts = ckptInfo.CheckpointLoaderSimple.input.required.ckpt_name[0]
  const ckptName = BASE_MODEL.split('/').at(-1)
  if (!ckpts.includes(ckptName)) {
    throw new Error(`ComfyUI 看不到底模 ${ckptName}；现有：${ckpts.slice(0, 8).join(', ')}`)
  }
  console.log(`[post] ComfyUI 可见：${files.length} 只 LoRA + ${ckptName} ✓`)
}

async function finalize(doneJob, { trigger: triggerWord, stepsPerEpoch }) {
  const name = doneJob.params?.name ?? job.name
  const epochs = Number(doneJob.params?.maxTrainEpochs ?? 3)
  if (['failed', 'cancelled'].includes(doneJob.status)) {
    throw new Error(`job ${doneJob.id} 终态 ${doneJob.status}：${doneJob.error ?? ''}`)
  }
  if (doneJob.status === 'running' || doneJob.status === 'pending') {
    await waitForJob(doneJob.id)
  }
  const artifacts = await discoverArtifacts(name, epochs, doneJob.id)
  console.log(`[post] 产物 ${artifacts.map((a) => a.file).join(', ')}`)
  await deployArtifacts(name, artifacts)
  await confirmVisible(artifacts)
  if (values['no-verify']) {
    console.log('\n[post] --no-verify：跳过验证矩阵。手工跑：')
    printVerifyHint(name, artifacts)
    return
  }
  const outDir = join(repoRoot, '..', 'experiments', 'runs', `${name}-VERIFY-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`)
  const args = [
    join(scriptDir, 'verify_ax4z_lora.mjs'),
    '--job', name,
    '--loras', artifacts.map((a) => a.file).join(','),
    '--labels', artifacts.map((a) => a.label).join(','),
    '--steps-per-epoch', String(stepsPerEpoch || 0),
    '--trigger', triggerWord,
    '--out', outDir,
  ]
  console.log(`\n[post] 启动验证矩阵 → ${outDir}`)
  const run = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' })
  if (run.status !== 0) throw new Error(`验证矩阵退出码 ${run.status}`)
  console.log(`\n[post] 全流程完成。产物目录：${outDir}`)
  console.log('  目检重点：风格锚是否注入、场景构图是否稳定、有无景别漂移/底模先验泄漏。')
}

function printVerifyHint(name, artifacts) {
  console.log(`  node ${join(scriptDir, 'verify_ax4z_lora.mjs')} --job ${name} --loras ${artifacts.map((a) => a.file).join(',')} --trigger <触发词>`)
}

async function fetchJson(path, init) {
  const url = /^https?:\/\//.test(path) ? path : `${trainerBase}${path}`
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`)
  return res.json()
}
