// ComfyUI 生成图详情：从 PNG 的 tEXt 块读 ComfyUI 写进去的 prompt/workflow，
// 再把 prompt（API 格式的节点图）压成一段人能读的生成信息。
// pngjs 只解 IDAT，不保留 text，所以这里单独走一遍 chunk 解析。

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 读 PNG 的 tEXt 块（ComfyUI 的 prompt / workflow 都是未压缩 tEXt）。 */
export function readPngText(bytes: Uint8Array): Record<string, string> {
  const buf = Buffer.from(bytes)
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return {}
  const text: Record<string, string> = {}
  let offset = 8
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    if (length > buf.length - offset - 12) break
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'tEXt') {
      const nul = data.indexOf(0)
      if (nul > 0) {
        const key = data.toString('latin1', 0, nul)
        text[key] = data.toString('utf8', nul + 1)
      }
    } else if (type === 'IDAT' || type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  return text
}

export interface ComfyNode {
  class_type?: string
  inputs?: Record<string, unknown>
  _meta?: { title?: string }
}

export type ComfyPrompt = Record<string, ComfyNode>

export function parseComfyPrompt(text: string | undefined): ComfyPrompt | null {
  if (!text) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as ComfyPrompt
  } catch {
    return null
  }
}

export interface GenerationInfo {
  /** 实际生效的 prompt 文本（顺 KSampler 的 positive/negative 连线找） */
  positive: string
  negative: string
  nodes: Array<{ id: string; type: string; title: string; inputs: Record<string, string> }>
  checkpoint: string
  loras: Array<{ name: string; strength: number }>
  controlnets: Array<{ name: string; strength: number }>
  seed: number | null
  steps: number | null
  cfg: number | null
  sampler: string
  scheduler: string
  denoise: number | null
  width: number | null
  height: number | null
}

function upstream(prompt: ComfyPrompt, input: unknown): string {
  if (Array.isArray(input) && typeof input[0] === 'string') return input[0]
  return ''
}

// CLIPTextEncode 的文本可能经 ControlNetApply(Advanced) 的 positive/negative 透传，
// 顺着连线一直找到真正带 text 的节点。
function nodeText(prompt: ComfyPrompt, nodeId: string, key: 'positive' | 'negative', depth = 0): string {
  if (depth > 8) return ''
  const node = prompt[nodeId]
  if (!node?.inputs) return ''
  const text = node.inputs.text
  if (typeof text === 'string') return text
  const next = upstream(prompt, node.inputs[key])
  return next ? nodeText(prompt, next, key, depth + 1) : ''
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 把 ComfyUI API prompt 节点图压成摘要；纯函数，便于单测。 */
export function summarizePrompt(prompt: ComfyPrompt | null): GenerationInfo {
  const empty: GenerationInfo = {
    positive: '',
    negative: '',
    nodes: [],
    checkpoint: '',
    loras: [],
    controlnets: [],
    seed: null,
    steps: null,
    cfg: null,
    sampler: '',
    scheduler: '',
    denoise: null,
    width: null,
    height: null,
  }
  if (!prompt) return empty

  const nodes: GenerationInfo['nodes'] = []
  let checkpoint = ''
  const loras: GenerationInfo['loras'] = []
  const controlnets: GenerationInfo['controlnets'] = []
  let latent: { width: number | null; height: number | null } | null = null
  let samplerNode: ComfyNode | undefined
  let samplerId = ''

  for (const [id, node] of Object.entries(prompt)) {
    const type = str(node?.class_type)
    const ins = node?.inputs ?? {}
    const inputs: Record<string, string> = {}
    for (const [key, value] of Object.entries(ins)) {
      if (typeof value === 'string') inputs[key] = value
      else if (typeof value === 'number' || typeof value === 'boolean')
        inputs[key] = String(value)
      else if (Array.isArray(value) && value.length > 0)
        inputs[key] = `← ${String(value[0])}`
    }
    nodes.push({
      id,
      type,
      title: str(node?._meta?.title),
      inputs,
    })

    if (/checkpointloader/i.test(type)) checkpoint = str(ins.ckpt_name) || checkpoint
    if (/loraloader/i.test(type)) {
      const name = str(ins.lora_name)
      if (name) loras.push({ name, strength: num(ins.strength_model) ?? 1 })
    }
    if (/controlnetloader/i.test(type)) {
      const name = str(ins.control_net_name)
      if (name) controlnets.push({ name, strength: 0 })
    }
    if (/controlnetapply/i.test(type)) {
      const strength = num(ins.strength) ?? 1
      const loaderId = upstream(prompt, ins.control_net)
      const loaderName = loaderId
        ? str(prompt[loaderId]?.inputs?.control_net_name)
        : ''
      const name = loaderName || str(ins.control_net)
      if (name) {
        const hit = controlnets.find((item) => item.name === name)
        if (hit) hit.strength = strength
        else controlnets.push({ name, strength })
      }
    }
    if (/emptylatentimage/i.test(type)) {
      latent = { width: num(ins.width), height: num(ins.height) }
    }
    if (/^ksampler$|^samplercustom|^basicscheduler/i.test(type)) {
      samplerNode = node
      samplerId = id
    }
  }

  const ins = samplerNode?.inputs ?? {}
  const positive = nodeText(prompt, upstream(prompt, ins.positive), 'positive')
  const negative = nodeText(prompt, upstream(prompt, ins.negative), 'negative')

  return {
    positive,
    negative,
    nodes,
    checkpoint,
    loras,
    controlnets,
    seed: num(ins.seed) ?? num(ins.noise_seed),
    steps: num(ins.steps),
    cfg: num(ins.cfg),
    sampler: str(ins.sampler_name) || (samplerId ? str(prompt[samplerId]?.class_type) : ''),
    scheduler: str(ins.scheduler),
    denoise: num(ins.denoise),
    width: latent?.width ?? null,
    height: latent?.height ?? null,
  }
}

/** 详情里展示的生成信息：raw prompt + 摘要。 */
export function generationFromPng(
  bytes: Uint8Array,
): { prompt: ComfyPrompt | null; info: GenerationInfo } {
  const text = readPngText(bytes)
  const prompt = parseComfyPrompt(text.prompt)
  return { prompt, info: summarizePrompt(prompt) }
}
