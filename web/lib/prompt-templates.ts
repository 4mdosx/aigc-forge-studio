import { creativeIntentType, initialIntent } from './intent'
import type { PromptTemplate } from './types'

export function readPromptTemplates(value: unknown): PromptTemplate[] {
  if (!Array.isArray(value)) {
    throw new Error('promptTemplates must be an array')
  }
  const templates: PromptTemplate[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const id = text(record.id)
    const name = text(record.name)
    const system = text(record.system)
    const chatType = text(record.chatType)
    if (id === '' || name === '' || system === '') continue
    if (chatType !== creativeIntentType) continue
    if (templates.some((template) => template.id === id)) continue
    templates.push({
      id,
      chatType,
      name,
      system,
      initialResult: structuredClone(initialIntent),
    })
  }
  return templates
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
