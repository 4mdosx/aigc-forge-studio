import { RunnerError } from '../errors.ts'
import type { Prompt, WorkflowNode } from './graph.ts'

export interface Binding {
  class_type: string
  name?: string
  id?: string
  input?: string
  upload?: boolean
  // 值域映射（可选）：入参值 → 节点实际值。用例：step("600"|"1200"|"1800")
  //   → lora_name 文件名。命中 map 才写节点；未命中报错（防乱值直透）。
  map?: Record<string, string>
}

export interface AdapterMap {
  inputs: Record<string, Binding>
  outputs: Record<string, Binding>
  // prompt 组装层（2026-11-15 三段模型）：compose 时素材段(rawPositive/rawNegative)
  // + 目的段(本块 anchors/negativeExtra) + 方言段(checkpoint promptProfile) 在
  // createTask 内组装。inputs/outputs 不受影响，缺省行为与旧版完全一致。
  prompt?: {
    compose?: boolean
    anchors?: string[]
    negativeExtra?: string[]
  }
}

export function parseAdapter(raw: unknown): AdapterMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RunnerError('adapter must be an object')
  }
  const record = raw as Record<string, unknown>
  return {
    inputs: bindings(record.inputs, true),
    outputs: bindings(record.outputs, false),
    ...(record.prompt !== undefined ? { prompt: parsePromptIntent(record.prompt) } : {}),
  }
}

function parsePromptIntent(raw: unknown): AdapterMap['prompt'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RunnerError('adapter prompt must be an object')
  }
  const record = raw as Record<string, unknown>
  const intent: NonNullable<AdapterMap['prompt']> = {}
  if (record.compose !== undefined) {
    if (typeof record.compose !== 'boolean') {
      throw new RunnerError('adapter prompt.compose must be a boolean')
    }
    intent.compose = record.compose
  }
  intent.anchors = stringArrayOf(record.anchors, 'prompt.anchors')
  intent.negativeExtra = stringArrayOf(record.negativeExtra, 'prompt.negativeExtra')
  return intent
}

function stringArrayOf(raw: unknown, label: string): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
    throw new RunnerError(`adapter ${label} must be a string array`)
  }
  return raw as string[]
}

export function suggestAdapter(prompt: Prompt): AdapterMap | null {
  const inputs: Record<string, Binding> = {}
  const outputs: Record<string, Binding> = {}
  const loaders = nodesOf(prompt, 'LoadImage')
  const loader = loaders[0]
  if (loaders.length === 1 && loader) {
    inputs.path = titled(
      { class_type: 'LoadImage', input: 'image', upload: true },
      loader[1],
    )
  }
  const clips = nodesOf(prompt, 'CLIPTextEncode')
  const positive = clips.filter(([, node]) =>
    /positive/i.test(node._meta?.title ?? ''),
  )
  const textNode =
    positive.length === 1
      ? positive[0]
      : clips.length === 1
        ? clips[0]
        : undefined
  if (textNode) {
    inputs.text = titled(
      { class_type: 'CLIPTextEncode', input: 'text' },
      textNode[1],
    )
  }
  const samplers = Object.entries(prompt).filter(([, node]) =>
    samplerTypes.has(node.class_type),
  )
  const sampler = samplers[0]
  if (samplers.length === 1 && sampler) {
    inputs.seed = titled(
      { class_type: sampler[1].class_type, input: 'seed' },
      sampler[1],
    )
  }
  const saves = Object.entries(prompt).filter(([, node]) =>
    saveTypes.has(node.class_type),
  )
  const save = saves[0]
  if (saves.length === 1 && save) {
    outputs.images = titled({ class_type: save[1].class_type }, save[1])
  }
  if (Object.keys(inputs).length === 0) return null
  return { inputs, outputs }
}

export function adapterFit(
  prompt: Prompt,
  adapterJson: string | null,
): { status: 'missing' | 'ready' | 'mismatch'; error?: string } {
  if (!adapterJson) return { status: 'missing' }
  try {
    assertAdapter(prompt, parseAdapter(JSON.parse(adapterJson) as unknown))
    return { status: 'ready' }
  } catch (err) {
    return {
      status: 'mismatch',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function assertAdapter(prompt: Prompt, adapter: AdapterMap): void {
  for (const binding of Object.values(adapter.inputs))
    matchNode(prompt, binding)
  for (const binding of Object.values(adapter.outputs))
    matchNode(prompt, binding)
}

export function applyAdapter(
  source: Prompt,
  adapter: AdapterMap,
  values: Record<string, unknown>,
  randomSeed: () => number,
): { prompt: Prompt; input: Record<string, unknown> } {
  const prompt = structuredClone(source)
  const input: Record<string, unknown> = {}
  for (const [key, binding] of Object.entries(adapter.inputs)) {
    if (!binding.input)
      throw new RunnerError(`adapter input ${key} needs an input name`)
    const provided = seedValue(binding, values[key], randomSeed, key)
    if (provided === undefined) throw new RunnerError(`missing input ${key}`)
    let value = provided
    if (binding.map) {
      value = binding.map[String(provided)]
      if (value === undefined) {
        throw new RunnerError(
          `input ${key}: ${String(provided)} not in map (${Object.keys(binding.map).join('/')})`,
        )
      }
    }
    const node = matchNode(prompt, binding)
    if (!Object.hasOwn(node.node.inputs, binding.input)) {
      throw new RunnerError(`node ${node.id} has no input ${binding.input}`)
    }
    node.node.inputs[binding.input] = value
    // 记原始值（映射前）：执行期 preparedPrompt 会用 input_json 重放本函数，
    // 存映射后的值会二次查 map 而炸。原始值重放幂等。
    input[key] = provided
  }
  for (const key of Object.keys(values)) {
    if (!adapter.inputs[key]) throw new RunnerError(`unknown input ${key}`)
  }
  return { prompt, input }
}

export function matchNode(
  prompt: Prompt,
  binding: Binding,
): { id: string; node: WorkflowNode } {
  const found = Object.entries(prompt).filter(
    ([, node]) => node.class_type === binding.class_type,
  )
  const named = binding.name
    ? found.filter(([, node]) => node._meta?.title === binding.name)
    : found
  if (named.length !== 1) {
    throw new RunnerError(
      named.length === 0
        ? `no ${binding.class_type}${binding.name ? ` named ${binding.name}` : ''}`
        : `${binding.class_type} matched ${named.length} nodes`,
    )
  }
  const pair = named[0]
  if (!pair) throw new RunnerError(`no ${binding.class_type}`)
  const [id, node] = pair
  if (binding.id !== undefined && binding.id !== id) {
    throw new RunnerError(
      `${binding.class_type} id changed from ${binding.id} to ${id}`,
    )
  }
  return { id, node }
}

const samplerTypes = new Set(['KSampler', 'KSamplerAdvanced'])
const saveTypes = new Set(['SaveImage', 'SaveImageAdvanced'])

function nodesOf(
  prompt: Prompt,
  classType: string,
): Array<[string, WorkflowNode]> {
  return Object.entries(prompt).filter(
    ([, node]) => node.class_type === classType,
  )
}

function titled(binding: Binding, node: WorkflowNode): Binding {
  const title = node._meta?.title
  if (title) binding.name = title
  return binding
}

function seedValue(
  binding: Binding,
  provided: unknown,
  randomSeed: () => number,
  key: string,
): unknown {
  if (binding.input !== 'seed') return provided
  if (provided === undefined || provided === 'random') return randomSeed()
  if (
    typeof provided === 'number' &&
    Number.isInteger(provided) &&
    provided >= 0
  )
    return provided
  if (typeof provided === 'string' && /^\d+$/.test(provided))
    return Number(provided)
  throw new RunnerError(`${key} must be an integer or random`)
}

function bindings(
  raw: unknown,
  requireInput: boolean,
): Record<string, Binding> {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RunnerError('adapter bindings must be an object')
  }
  const parsed: Record<string, Binding> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new RunnerError(`adapter ${key} must be an object`)
    }
    const record = value as Record<string, unknown>
    if (typeof record.class_type !== 'string' || record.class_type === '') {
      throw new RunnerError(`adapter ${key} needs a class_type`)
    }
    const binding: Binding = { class_type: record.class_type }
    if (record.name !== undefined) {
      if (typeof record.name !== 'string' || record.name === '') {
        throw new RunnerError(`adapter ${key} name must be a string`)
      }
      binding.name = record.name
    }
    if (record.id !== undefined) {
      if (typeof record.id !== 'string' || record.id === '') {
        throw new RunnerError(`adapter ${key} id must be a string`)
      }
      binding.id = record.id
    }
    if (record.input !== undefined) {
      if (typeof record.input !== 'string' || record.input === '') {
        throw new RunnerError(`adapter ${key} input must be a string`)
      }
      binding.input = record.input
    } else if (requireInput) {
      throw new RunnerError(`adapter ${key} needs an input name`)
    }
    if (record.upload === true) binding.upload = true
    if (record.map !== undefined) {
      if (
        !record.map ||
        typeof record.map !== 'object' ||
        Array.isArray(record.map) ||
        Object.entries(record.map).some(
          ([k, v]) => typeof k !== 'string' || typeof v !== 'string',
        )
      ) {
        throw new RunnerError(`adapter ${key} map must be a string-to-string record`)
      }
      binding.map = record.map as Record<string, string>
    }
    parsed[key] = binding
  }
  return parsed
}
