import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { branchOf, revisionById, workflowByName } from './db.ts'
import { RunnerError } from './errors.ts'
import { createJobRaw } from './jobFactory.ts'
import { joinPrompt, readRollConfig } from './rollConfig.ts'
import { matchNode, type AdapterMap, type Binding } from './workflow/binding.ts'
import type { Runner } from './task/queue.ts'
import type { Prompt } from './workflow/graph.ts'

// 生产接口：workflow 版本对外不可见，一律取 main head。
// 每个接口在代码里声明自己的 adapter（work/adapter_json 那套已冻结）。
export type GenerateKind = 'cn' | 'base'

export interface GenerateInput {
  prompt: string
  repeat: number
  // 留空 = 不覆盖 workflow 里的 LoRA（快速出图默认 gloss 1.0 + struct 0.8）
  loraName: string
  poseName?: string
}

interface Spec {
  workflowName: string
  adapter: AdapterMap
  label: string
  withPose: boolean
}

const node = (type: string, name: string | undefined, input?: string) => ({
  class_type: type,
  ...(name ? { name } : {}),
  ...(input ? { input } : {}),
})

// base_ax4z_lora_cn_1：双 ControlNet，repeat 走 RepeatLatentBatch.amount
const cnSpec: Spec = {
  workflowName: 'base_ax4z_lora_cn_1',
  label: 'CN',
  withPose: true,
  adapter: {
    inputs: {
      positive: node('CLIPTextEncode', 'Positive', 'text'),
      negative: node('CLIPTextEncode', 'Negative', 'text'),
      width: node('EmptyLatentImage', 'Empty Latent', 'width'),
      height: node('EmptyLatentImage', 'Empty Latent', 'height'),
      batch: node('RepeatLatentBatch', 'Repeat Latent', 'amount'),
      seed: node('KSampler', 'Base KSampler', 'seed'),
      denoise: node('KSampler', 'Base KSampler', 'denoise'),
      lora_name: node('LoraLoader', 'Style LoRA (strength 0 = off)', 'lora_name'),
      pose_image: { ...node('LoadImage', 'Skeleton Image', 'image'), upload: true },
      depth_image: { ...node('LoadImage', 'Depth Image', 'image'), upload: true },
    },
    outputs: { image: node('SaveImage', 'Save') },
  },
}

// baseline_ax4z_lora_v1：无 CN，repeat 走 EmptyLatentImage.batch_size
const baseSpec: Spec = {
  workflowName: 'baseline_ax4z_lora_v1',
  label: 'Base',
  withPose: false,
  adapter: {
    inputs: {
      positive: node('CLIPTextEncode', 'Positive Prompt', 'text'),
      negative: node('CLIPTextEncode', 'Negative Prompt', 'text'),
      width: node('EmptyLatentImage', 'Empty Latent', 'width'),
      height: node('EmptyLatentImage', 'Empty Latent', 'height'),
      batch: node('EmptyLatentImage', 'Empty Latent', 'batch_size'),
      seed: node('KSampler', undefined, 'seed'),
      lora_name: node('LoraLoader', 'LoRA', 'lora_name'),
    },
    outputs: { images: node('SaveImage', undefined) },
  },
}

export const GENERATE_SPECS: Record<GenerateKind, Spec> = {
  cn: cnSpec,
  base: baseSpec,
}

export function parseGenerateInput(
  kind: GenerateKind,
  raw: Record<string, unknown>,
): GenerateInput {
  const prompt = requiredString(raw.prompt, 'prompt')
  const repeat = raw.repeat
  if (
    typeof repeat !== 'number' ||
    !Number.isInteger(repeat) ||
    repeat < 1 ||
    repeat > 16
  ) {
    throw new RunnerError('repeat must be an integer between 1 and 16')
  }
  // loraName 可缺省（2026-11-24）：不传就是沿用 workflow 里的 LoRA。
  // 快速出图的图里已经绑好 gloss 1.0 + struct 0.8，前端「默认」选项不该被迫传值。
  const loraName = typeof raw.loraName === 'string' ? raw.loraName.trim() : ''
  const poseName =
    typeof raw.poseName === 'string' ? raw.poseName.trim() : ''
  if (spec(kind).withPose && poseName === '') {
    throw new RunnerError('poseName is required for cn generation')
  }
  if (!spec(kind).withPose && poseName !== '') {
    throw new RunnerError('base generation does not accept poseName')
  }
  return {
    prompt,
    repeat,
    loraName,
    ...(poseName ? { poseName } : {}),
  }
}

function spec(kind: GenerateKind): Spec {
  const value = GENERATE_SPECS[kind]
  if (!value) throw new RunnerError(`unknown generate kind: ${kind}`)
  return value
}

// 取 workflow 的 main head（版本对接口不可见）
export function getHeadWorkflow(db: DatabaseSync, name: string) {
  const workflow = workflowByName(db, name)
  const branch = branchOf(db, workflow.id, 'main')
  const revision = revisionById(db, branch.head_revision_id)
  return { workflow, revision, api: JSON.parse(revision.api_json) as Prompt }
}

export async function createGeneration(
  runner: Runner,
  kind: GenerateKind,
  input: GenerateInput,
): Promise<{ jobId: string }> {
  const s = spec(kind)
  const { workflow, revision, api } = getHeadWorkflow(runner.db, s.workflowName)
  const rollConfig = readRollConfig(runner.db)

  const overrides: Record<string, unknown> = {
    batch: input.repeat,
  }
  if (input.loraName !== '') overrides.lora_name = input.loraName
  if (s.withPose) {
    Object.assign(overrides, await poseOverrides(runner, input.poseName ?? ''))
  }

  const payload = buildPayload(api, s.adapter, input.prompt, rollConfig, overrides)
  const id = `gen-${kind}-${randomUUID().slice(0, 8)}`

  const result = createJobRaw(runner.db, runner.now(), {
    workflowName: s.workflowName,
    adapter: s.adapter,
    revisionApiJson: revision.api_json,
    revisionId: revision.id,
    payload,
    task: id,
    label: s.label,
    recipeKind: kind,
    recipe: input as unknown as Record<string, unknown>,
  })
  return { jobId: result.jobId }
}

async function poseOverrides(
  runner: Runner,
  poseName: string,
): Promise<Record<string, unknown>> {
  if (poseName === '') throw new RunnerError('poseName is required')
  const variant = poseVariant(runner, poseName)
  const client = runner.clients[0]
  if (!client) throw new RunnerError('no ComfyUI instance')
  const sub = `generate/${poseName}`
  const read = (rel: string, label: string): Uint8Array => {
    const path = join(runner.dataDir, rel)
    if (!existsSync(path)) throw new RunnerError(`pose ${label} file missing: ${rel}`, 404)
    return new Uint8Array(readFileSync(path))
  }
  await client.uploadBytes(read(variant.depth, 'depth'), 'depth.png', sub)
  await client.uploadBytes(read(variant.bone, 'bone'), 'bone.png', sub)
  const gen = variant.gen
  if (!gen || gen.length < 2) throw new RunnerError('pose has no gen size')
  return {
    pose_image: `${sub}/bone.png`,
    depth_image: `${sub}/depth.png`,
    width: gen[0],
    height: gen[1],
  }
}

interface PoseVariant {
  gen?: number[]
  depth: string
  bone: string
}

function poseVariant(runner: Runner, poseName: string): PoseVariant {
  const manifestPath = join(runner.dataDir, 'pose', 'manifest.json')
  if (!existsSync(manifestPath)) throw new RunnerError('data/pose/manifest.json missing', 404)
  let manifest: { poses?: Array<{ id: string; variants?: Record<string, PoseVariant> }> }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest
  } catch (err) {
    throw new RunnerError(`invalid manifest: ${err instanceof Error ? err.message : String(err)}`)
  }
  const entry = (manifest.poses ?? []).find((p) => p.id === poseName)
  if (!entry) throw new RunnerError(`pose ${poseName} not in manifest`, 404)
  const variant = Object.values(entry.variants ?? {}).find(
    (v) => v && v.gen && v.depth && v.bone,
  )
  if (!variant) throw new RunnerError(`pose ${poseName} has no usable variant`, 404)
  return variant
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RunnerError(`${name} is required`)
  }
  return value.trim()
}

// 按代码内声明的 adapter 组装 payload：固定质量词 + 输入 prompt 接正面，
// seed 交给执行时随机，其余入参取 workflow 节点现值再被 overrides 覆盖。
function buildPayload(
  api: Prompt,
  adapter: AdapterMap,
  prompt: string,
  config: { workflowPositive: string; workflowNegative: string },
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [key, binding] of Object.entries(adapter.inputs)) {
    if (!binding.input) throw new RunnerError(`adapter input ${key} needs an input name`)
    if (binding.input === 'seed') {
      payload[key] = 'random'
      continue
    }
    const current = matchNode(api, binding).node.inputs[binding.input]
    if (!fillable(current)) throw new RunnerError(`cannot fill ${key} from the workflow`)
    payload[key] = current
  }
  if (!Object.hasOwn(payload, 'positive')) {
    throw new RunnerError('workflow adapter has no positive input')
  }
  if (!Object.hasOwn(payload, 'negative')) {
    throw new RunnerError('workflow adapter has no negative input')
  }
  // 词序（2026-11-24）：workflow 自带的文本优先，roll_config 只作兜底。
  // 快速出图的图里写死了定案正负面（质感和机设全押在负面里的 rust/weathering/
  // segmented armor），用 roll_config 去覆盖会把这些词整段丢掉；roll_config 仍然
  // 服务 dice 那条独立的拼接路径，不在这里共用。
  payload.positive = joinPrompt(textOf(api, adapter.inputs.positive) || config.workflowPositive, prompt)
  payload.negative = textOf(api, adapter.inputs.negative) || config.workflowNegative
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'positive' || key === 'negative') continue
    if (!Object.hasOwn(payload, key)) continue
    payload[key] = value
  }
  return payload
}

function fillable(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return false
  if (typeof value === 'object') return false
  return true
}

// 取 workflow 里绑定节点上现存的文本（正/负面），空字符串表示图没写词。
function textOf(api: Prompt, binding: Binding | undefined): string {
  if (!binding || !binding.input) return ''
  const value = matchNode(api, binding).node.inputs[binding.input]
  return typeof value === 'string' ? value.trim() : ''
}
