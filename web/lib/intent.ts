export const creativeIntentType = 'creative-intent'

export const patchProtocol = `只返回一个 JSON 对象，不要使用 Markdown。
对象只有 message 和 patch。
message 用中文。提到创作意图里的关键词时写成中文（英文），例如银发女巫（silver-haired witch）。
patch 里的字符串全部用英文。
patch 是对创作意图的局部修改：对象按字段合并，数组必须给出完整的新数组，null 把该字段恢复成空。
patch 为 {} 时不修改创作意图。`

export type IntentField =
  | { kind: 'string' }
  | { kind: 'strings' }
  | { kind: 'object'; fields: Record<string, IntentField> }

const text: IntentField = { kind: 'string' }
const list: IntentField = { kind: 'strings' }

function object(fields: Record<string, IntentField>): IntentField {
  return { kind: 'object', fields }
}

export const intentSchema: IntentField = object({
  subject: object({
    type: text,
    description: text,
  }),
  outfit: object({
    clothing: text,
    accessories: list,
  }),
  pose: object({
    action: text,
    expression: text,
  }),
  composition: object({
    shot: text,
    view: text,
    framing: text,
  }),
  environment: object({
    background: text,
  }),
  lighting: object({
    type: text,
  }),
  style: object({
    genre: text,
    rendering: text,
  }),
  constraints: object({
    exclude: list,
  }),
  repaint: object({
    target: text,
    prompt: text,
  }),
})

export interface CreativeIntent {
  subject: { type: string; description: string }
  outfit: { clothing: string; accessories: string[] }
  pose: { action: string; expression: string }
  composition: { shot: string; view: string; framing: string }
  environment: { background: string }
  lighting: { type: string }
  style: { genre: string; rendering: string }
  constraints: { exclude: string[] }
  repaint: { target: string; prompt: string }
}

export const initialIntent = emptyField(intentSchema) as CreativeIntent

export function intentSystem(instructions: string): string {
  return `${instructions.trim()}\n\n${patchProtocol}\n\n创作意图的数据结构：\n${JSON.stringify(intentSchema, null, 2)}`
}

export function modelSystem(instructions: string, result: unknown): string {
  return `${intentSystem(instructions)}\n\n当前创作意图：\n${JSON.stringify(result, null, 2)}`
}

export function parseReply(text: string): {
  message: string
  patch: Record<string, unknown>
} {
  let value: unknown
  try {
    value = JSON.parse(jsonText(text))
  } catch {
    throw new Error('LLM did not return JSON')
  }
  if (!isPlain(value)) throw new Error('LLM did not return a message and patch')
  const message = value.message
  const patch = value.patch
  if (typeof message !== 'string' || message.trim() === '') {
    throw new Error('LLM did not return a message and patch')
  }
  if (!isPlain(patch)) throw new Error('patch must be an object')
  return { message: message.trim(), patch }
}

export function applyPatch(
  current: CreativeIntent,
  patch: unknown,
): CreativeIntent {
  if (!isPlain(patch)) throw new Error('patch must be an object')
  if (Object.keys(patch).length === 0) return current
  return mergeField(intentSchema, current, patch, '') as CreativeIntent
}

function mergeField(
  field: IntentField,
  current: unknown,
  patch: unknown,
  path: string,
): unknown {
  if (patch === null) return emptyField(field)
  if (field.kind === 'string') {
    if (typeof patch !== 'string') throw new Error(`${path} must be a string`)
    return patch
  }
  if (field.kind === 'strings') {
    if (
      !Array.isArray(patch) ||
      patch.some((item) => typeof item !== 'string')
    ) {
      throw new Error(`${path} must be a list of strings`)
    }
    return [...patch]
  }
  if (!isPlain(patch)) throw new Error(`${path} must be an object`)
  const base = isPlain(current) ? current : {}
  const next = emptyField(field) as Record<string, unknown>
  for (const key of Object.keys(field.fields)) {
    if (key in base) next[key] = base[key]
  }
  for (const key of Object.keys(patch)) {
    const child = field.fields[key]
    const childPath = path ? `${path}.${key}` : key
    if (!child) throw new Error(`unknown field ${childPath}`)
    next[key] = mergeField(child, base[key], patch[key], childPath)
  }
  return next
}

function emptyField(field: IntentField): unknown {
  if (field.kind === 'string') return ''
  if (field.kind === 'strings') return []
  const value: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(field.fields)) {
    value[key] = emptyField(child)
  }
  return value
}

function jsonText(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  return fenced?.[1] ?? trimmed
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
