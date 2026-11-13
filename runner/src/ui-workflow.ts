import { readFileSync } from 'node:fs'

import { RunnerError } from './errors.ts'
import type { Prompt } from './workflow.ts'

const SKIP_TYPES = new Set(['Note', 'MarkdownNote'])
const SKIP_INPUTS = new Set(['upload'])

interface UiWidget {
  name?: string
}

interface UiInput {
  name?: string
  link?: number | null
  widget?: UiWidget
}

interface UiNode {
  id?: number
  type?: string
  title?: string
  inputs?: UiInput[]
  widgets_values_named?: Record<string, unknown>
}

interface UiLink {
  id: number
  from: string
  slot: number
}

export function uiWorkflowToPrompt(path: string): Prompt {
  const raw = readJson(path)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RunnerError(`${path} must be a ComfyUI workflow object`)
  }
  const workflow = raw as { nodes?: unknown; links?: unknown }
  if (!Array.isArray(workflow.nodes) || !Array.isArray(workflow.links)) {
    throw new RunnerError(`${path} is missing nodes or links`)
  }

  const links = new Map<number, UiLink>()
  for (const link of workflow.links) {
    if (!Array.isArray(link) || link.length < 3) {
      throw new RunnerError(`${path} has a link that is not an array`)
    }
    const [id, from, slot] = link
    if (
      typeof id !== 'number' ||
      typeof from !== 'number' ||
      typeof slot !== 'number'
    ) {
      throw new RunnerError(`${path} has a link with a non-numeric id`)
    }
    links.set(id, { id, from: String(from), slot })
  }

  const prompt: Prompt = {}
  for (const node of workflow.nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new RunnerError(`${path} has a node that is not an object`)
    }
    const ui = node as UiNode
    if (typeof ui.type !== 'string' || typeof ui.id !== 'number') {
      throw new RunnerError(`${path} has a node without id or type`)
    }
    if (SKIP_TYPES.has(ui.type)) continue

    const inputs: Record<string, unknown> = {}
    for (const input of ui.inputs ?? []) {
      if (!input.name || SKIP_INPUTS.has(input.name)) continue
      if (typeof input.link === 'number') {
        const link = links.get(input.link)
        if (!link)
          throw new RunnerError(
            `${path} node ${ui.id} link ${input.link} is missing`,
          )
        inputs[input.name] = [link.from, link.slot]
        continue
      }
      const widgetName = input.widget?.name ?? input.name
      if (SKIP_INPUTS.has(widgetName)) continue
      const named = ui.widgets_values_named ?? {}
      if (!Object.prototype.hasOwnProperty.call(named, widgetName)) {
        throw new RunnerError(
          `${path} node ${ui.id} is missing widget ${widgetName}`,
        )
      }
      inputs[input.name] = named[widgetName]
    }

    prompt[String(ui.id)] = {
      class_type: ui.type,
      inputs,
      ...(ui.title ? { _meta: { title: ui.title } } : {}),
    }
  }

  return prompt
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new RunnerError(`cannot read ${path}: ${detail}`)
  }
}
