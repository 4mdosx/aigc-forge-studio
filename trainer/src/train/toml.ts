import { join } from 'node:path'

import { TrainerError } from '../errors.ts'
import { relativePath } from '../path.ts'

// 训练参数解析与 TOML 生成。纯函数，无 IO，方便单测。
//
// 调用方只交白名单字段（与 runner「work semantic 白名单」同一纪律）：
// 未提供的数值字段落到风格 LoRA 默认档（依据 research/style-lora-dataset-requirements.md）。
// TOML 全部走顶层平铺键（--config_file 接受 section 但平铺最稳），
// 字符串用 TOML literal string（单引号）承载 Windows 反斜杠路径，免转义。

export interface TrainParamsInput {
  name: string
  /** 数据集所在 root 名（config roots，通常 'training'） */
  datasetRoot: string
  /** root 内相对路径，指向直接装着 图片+caption 的目录 */
  datasetPath: string
  /** models root 内相对路径，指向底模 safetensors */
  baseModel: string
  resolution?: number
  batchSize?: number
  numRepeats?: number
  networkDim?: number
  networkAlpha?: number
  unetLr?: number
  textEncoderLr?: number
  scheduler?: 'constant' | 'cosine' | 'linear'
  lrWarmupSteps?: number
  maxTrainEpochs?: number
  saveEveryNEpochs?: number
  clipSkip?: number
  minSnrGamma?: number
  sdpa?: boolean
  /** SDXL 家族训练开关；sd-scripts 不给 --sdxl 会走 SD1.x 加载路径读 SDXL 底模必炸（实测坑） */
  sdxl?: boolean
  shuffleCaption?: boolean
  keepTokens?: number
  /** 采样提示词全文；提供时写入 prompts 文件并按 sampleEveryNEpochs 出图 */
  samplePrompts?: string
  sampleEveryNEpochs?: number
}

export interface ResolvedParams extends Required<Omit<TrainParamsInput, 'samplePrompts'>> {
  samplePrompts: string | null
}

export interface JobPaths {
  /** 数据集目录绝对路径（训练机侧） */
  datasetDir: string
  /** 底模文件绝对路径 */
  modelPath: string
  /** 产物输出目录绝对路径 */
  outputDir: string
  /** 本 job 的配置/提示词目录绝对路径（training/<name>/config） */
  configDir: string
}

const NAME_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/i
const SCHEDULERS = ['constant', 'cosine', 'linear']

function num(
  body: Record<string, unknown>,
  key: string,
  fallback: number,
  { positive = true } = {},
): number {
  const raw = body[key]
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new TrainerError(`${key} must be a finite number`)
  }
  if (positive && raw <= 0) throw new TrainerError(`${key} must be > 0`)
  return raw
}

function bool(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const raw = body[key]
  if (raw === undefined) return fallback
  if (typeof raw !== 'boolean') throw new TrainerError(`${key} must be a boolean`)
  return raw
}

export function resolveParams(
  input: TrainParamsInput,
): ResolvedParams {
  if (!NAME_PATTERN.test(input.name)) {
    throw new TrainerError(
      'name must match [a-z][a-z0-9_-]{1,63} (folder name on the training machine)',
    )
  }
  // datasetPath/baseModel 走 relativePath 挡 '..' 等；白名单外字段由调用方拒绝
  const datasetPath = relativePath(input.datasetPath)
  const baseModel = relativePath(input.baseModel)

  const scheduler = input.scheduler ?? 'constant'
  if (!SCHEDULERS.includes(scheduler)) {
    throw new TrainerError(`scheduler must be one of: ${SCHEDULERS.join(', ')}`)
  }

  const fields = input as unknown as Record<string, unknown>
  return {
    name: input.name,
    datasetRoot: input.datasetRoot,
    datasetPath,
    baseModel,
    resolution: num(fields, 'resolution', 1024),
    batchSize: num(fields, 'batchSize', 1),
    numRepeats: num(fields, 'numRepeats', 10),
    networkDim: num(fields, 'networkDim', 128),
    networkAlpha: num(fields, 'networkAlpha', 32),
    unetLr: num(fields, 'unetLr', 4e-4, { positive: false }),
    textEncoderLr: num(fields, 'textEncoderLr', 5e-5, { positive: false }),
    scheduler,
    lrWarmupSteps: num(fields, 'lrWarmupSteps', 100, { positive: false }),
    maxTrainEpochs: num(fields, 'maxTrainEpochs', 10),
    saveEveryNEpochs: num(fields, 'saveEveryNEpochs', 1),
    clipSkip: num(fields, 'clipSkip', 2, { positive: false }),
    minSnrGamma: num(fields, 'minSnrGamma', 5, { positive: false }),
    sdpa: bool(fields, 'sdpa', true),
    sdxl: bool(fields, 'sdxl', true),
    shuffleCaption: bool(fields, 'shuffleCaption', true),
    keepTokens: num(fields, 'keepTokens', 0, { positive: false }),
    samplePrompts: input.samplePrompts?.trim() ? input.samplePrompts : null,
    sampleEveryNEpochs: num(fields, 'sampleEveryNEpochs', 1, { positive: false }),
  }
}

function literal(value: string): string {
  // 默认 TOML literal string（单引号，不转义），正好装 Windows 反斜杠路径。
  // 含单引号时退回 basic string（反斜杠转义、单引号原样），literal 不认 \'。
  if (!value.includes("'")) return `'${value}'`
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function value(raw: unknown): string {
  if (typeof raw === 'string') return literal(raw)
  if (typeof raw === 'boolean' || typeof raw === 'number') return String(raw)
  if (Array.isArray(raw)) return `[${raw.map(value).join(', ')}]`
  throw new TrainerError(`unsupported TOML value type: ${typeof raw}`)
}

/** 顶层平铺键值对 → TOML 文本 */
export function toToml(entries: Record<string, unknown>): string {
  return (
    Object.entries(entries)
      .map(([key, raw]) => `${key} = ${value(raw)}`)
      .join('\n') + '\n'
  )
}

/** 数据集配置 TOML（--dataset_config）：[general] + [[datasets]] + [[datasets.subsets]] */
export function buildDatasetToml(params: ResolvedParams, paths: JobPaths): string {
  const lines: string[] = []
  lines.push('[general]')
  lines.push(`shuffle_caption = ${params.shuffleCaption}`)
  lines.push(`caption_extension = ${literal('.txt')}`)
  lines.push(`keep_tokens = ${params.keepTokens}`)
  lines.push('')
  lines.push('[[datasets]]')
  lines.push(`resolution = ${params.resolution}`)
  lines.push(`batch_size = ${params.batchSize}`)
  lines.push('enable_bucket = true')
  lines.push('min_bucket_reso = 256')
  lines.push('max_bucket_reso = 2048')
  lines.push('')
  lines.push('[[datasets.subsets]]')
  lines.push(`image_dir = ${literal(paths.datasetDir)}`)
  lines.push(`num_repeats = ${params.numRepeats}`)
  return lines.join('\n') + '\n'
}

/** 训练参数 TOML（--config_file）：顶层平铺键，键名与 train_network.py CLI 参数一致 */
export function buildTrainToml(params: ResolvedParams, paths: JobPaths): string {
  const entries: Record<string, unknown> = {
    pretrained_model_name_or_path: paths.modelPath,
    output_dir: paths.outputDir,
    output_name: params.name,
    save_precision: 'fp16',
    save_model_as: 'safetensors',
    save_every_n_epochs: params.saveEveryNEpochs,
    mixed_precision: 'fp16',
    network_module: 'networks.lora',
    network_dim: params.networkDim,
    network_alpha: params.networkAlpha,
    optimizer_type: 'AdamW8bit',
    unet_lr: params.unetLr,
    text_encoder_lr: params.textEncoderLr,
    lr_scheduler: params.scheduler,
    lr_warmup_steps: params.lrWarmupSteps,
    max_train_epochs: params.maxTrainEpochs,
    gradient_checkpointing: true,
    cache_latents_to_disk: true,
    clip_skip: params.clipSkip,
    min_snr_gamma: params.minSnrGamma,
    sdpa: params.sdpa,
  }
  if (params.samplePrompts) {
    entries.sample_prompts = joinPath(paths.configDir, 'prompts.txt')
    entries.sample_every_n_epochs = params.sampleEveryNEpochs
    entries.sample_at_first = false
  }
  return toToml(entries)
}

// Windows 路径归一化：盘符开头的 root 统一用反斜杠连接（posix 测试环境 join 会出混合分隔符）。
// sd-scripts/python 只在 Windows 上跑，反斜杠/正斜杠都合法，这里只是求输出一致。
function joinPath(base: string, ...rest: string[]): string {
  const joined = join(base, ...rest)
  if (/^[a-zA-Z]:/.test(base)) return joined.replace(/\//g, '\\')
  return joined
}

/** 组装训练机侧各目录绝对路径（datasetDir 尊重 datasetPath，config/output 按 name 布局） */
export function jobPaths(
  roots: { training: string; models: string },
  params: ResolvedParams,
): JobPaths {
  const jobDir = joinPath(roots.training, params.name)
  return {
    datasetDir: joinPath(roots.training, params.datasetPath),
    modelPath: joinPath(roots.models, params.baseModel),
    outputDir: joinPath(jobDir, 'output'),
    configDir: joinPath(jobDir, 'config'),
  }
}
