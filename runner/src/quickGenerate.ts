import { RunnerError } from './errors.ts'
import { joinPrompt, type RollConfig } from './rollConfig.ts'
import { matchNode, type AdapterMap } from './workflow/binding.ts'
import type { Prompt } from './workflow/graph.ts'

// 快速出图和灵感出图同一套拼法：出图设置的正负向在前，输入的 prompt 接在正面后面。
// 快速出图没有单独的负面输入，负面就是设置里的负面词。
// 其余 adapter 入参取工作流节点上现有的值；带 map 的入参反查成 map 的键。seed 交给执行时随机。
// overrides 只覆盖 adapter 里已有、且不是正负向的字段（pose 图、尺寸）。
export function quickPayload(
  api: Prompt,
  adapter: AdapterMap,
  prompt: string,
  config: Pick<RollConfig, 'workflowPositive' | 'workflowNegative'>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [key, binding] of Object.entries(adapter.inputs)) {
    if (!binding.input) throw new RunnerError(`adapter input ${key} needs an input name`)
    if (binding.input === 'seed') {
      payload[key] = 'random'
      continue
    }
    const current = matchNode(api, binding).node.inputs[binding.input]
    if (binding.map) {
      payload[key] = mappedKey(key, binding.map, current)
      continue
    }
    if (!fillable(current)) throw new RunnerError(`cannot fill ${key} from the workflow`)
    payload[key] = current
  }
  if (!Object.hasOwn(payload, 'positive')) {
    throw new RunnerError('workflow adapter has no positive input')
  }
  if (!Object.hasOwn(payload, 'negative')) {
    throw new RunnerError('workflow adapter has no negative input')
  }
  payload.positive = joinPrompt(config.workflowPositive, prompt)
  payload.negative = joinPrompt(config.workflowNegative, '')
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'positive' || key === 'negative') continue
    if (!Object.hasOwn(payload, key)) continue
    payload[key] = value
  }
  return payload
}

// 选中的 LoRA 文件名写进 adapter 上真正连着 LoraLoader.lora_name 的字段。
// 该字段若是 map（baseline_v1 的 step），反查成 map 的键再传入。
export function loraOverride(adapter: AdapterMap, loraName: string): Record<string, unknown> {
  const name = loraName.trim()
  if (name === '') throw new RunnerError('lora name is required')
  for (const [key, binding] of Object.entries(adapter.inputs)) {
    if (binding.input !== 'lora_name') continue
    if (!binding.map) return { [key]: name }
    const found = Object.entries(binding.map).find(([, value]) => value === name)
    if (!found) {
      throw new RunnerError(
        `lora ${name} is not in ${key} (${Object.keys(binding.map).join('/')})`,
      )
    }
    return { [key]: found[0] }
  }
  throw new RunnerError('workflow adapter has no lora input')
}

function mappedKey(key: string, map: Record<string, string>, current: unknown): string {
  const found = Object.entries(map).find(([, value]) => value === current)
  if (!found) {
    throw new RunnerError(`cannot fill ${key} from ${String(current)}`)
  }
  return found[0]
}

function fillable(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return false
  if (typeof value === 'object') return false
  return true
}
