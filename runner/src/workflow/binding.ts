import { RunnerError } from '../errors.ts'
import type { Prompt, WorkflowNode } from './graph.ts'

export interface Binding {
  class_type: string
  name?: string
  id?: string
  input?: string
  upload?: boolean
}

export interface AdapterMap {
  inputs: Record<string, Binding>
  outputs: Record<string, Binding>
}

export function parseAdapter(raw: unknown): AdapterMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RunnerError('adapter must be an object')
  }
  const record = raw as Record<string, unknown>
  return {
    inputs: bindings(record.inputs, true),
    outputs: bindings(record.outputs, false),
  }
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
    const value = seedValue(binding, values[key], randomSeed, key)
    if (value === undefined) throw new RunnerError(`missing input ${key}`)
    const node = matchNode(prompt, binding)
    if (!Object.hasOwn(node.node.inputs, binding.input)) {
      throw new RunnerError(`node ${node.id} has no input ${binding.input}`)
    }
    node.node.inputs[binding.input] = value
    input[key] = value
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
    parsed[key] = binding
  }
  return parsed
}
