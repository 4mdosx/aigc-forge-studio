import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

import { currentApp } from './app.ts'
import { RunnerError } from './errors.ts'
import { uiWorkflowToPrompt } from './ui-workflow.ts'
import { setInput, type Prompt } from './workflow.ts'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'])

export interface AdapterBinding {
  node: string
  input: string
  upload?: boolean
}

export interface AdapterFile {
  model: string
  workflow: string
  inputs: Record<string, AdapterBinding>
}

export interface TaskResult {
  path: string
}

export function findAdapter(task: string, name: string): AdapterFile {
  const dir = join(import.meta.dirname, '..', 'adapter', task)
  let files: string[]
  try {
    files = readdirSync(dir).filter((file) => file.endsWith('.json'))
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new RunnerError(`cannot read adapters in ${dir}: ${detail}`)
  }

  const matches: AdapterFile[] = []
  for (const file of files) {
    const adapter = readAdapter(join(dir, file))
    if (adapter.model === name || file.replace(/\.json$/i, '') === name) {
      matches.push(adapter)
    }
  }
  const found = matches[0]
  if (!found || matches.length !== 1) {
    throw new RunnerError(
      matches.length > 1
        ? `more than one ${task} adapter matches ${name}`
        : `no ${task} adapter matches ${name}`,
    )
  }
  return found
}

export function promptFromAdapter(
  root: string,
  adapter: AdapterFile,
  values: Record<string, string>,
): {
  prompt: Prompt
  uploads: Array<{ node: string; input: string; file: string }>
} {
  const workflowPath = resolve(root, adapter.workflow)
  const prompt = uiWorkflowToPrompt(workflowPath)
  const uploads: Array<{ node: string; input: string; file: string }> = []

  for (const [key, binding] of Object.entries(adapter.inputs)) {
    const value = values[key]
    if (value === undefined) throw new RunnerError(`missing input ${key}`)
    if (binding.upload) {
      uploads.push({
        node: binding.node,
        input: binding.input,
        file: resolveImage(value),
      })
      continue
    }
    setInput(prompt, binding.node, binding.input, value)
  }

  for (const key of Object.keys(values)) {
    if (!adapter.inputs[key])
      throw new RunnerError(`${adapter.model} has no input ${key}`)
  }
  return { prompt, uploads }
}

export async function runTask(
  task: string,
  entry: string,
  values: Record<string, string>,
): Promise<TaskResult> {
  const app = currentApp()
  const adapter = findAdapter(task, entry)
  const outDir = taskOutputDir(app.outDir, task)
  const { prompt, uploads } = promptFromAdapter(app.root, adapter, values)
  for (const upload of uploads) {
    const name = await app.client.upload(upload.file)
    setInput(prompt, upload.node, upload.input, name)
  }
  await app.client.run(prompt, outDir, app.timeoutMs, app.signal)
  return { path: outDir }
}

export function taskOutputDir(outDir: string, task: string, date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    pad(date.getMilliseconds(), 3)
  return join(outDir, `${task}-${stamp}`)
}

function readAdapter(path: string): AdapterFile {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new RunnerError(`cannot read ${path}: ${detail}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RunnerError(`${path} must be a JSON object`)
  }
  const model = (raw as { model?: unknown }).model
  const workflow = (raw as { workflow?: unknown }).workflow
  const inputs = (raw as { inputs?: unknown }).inputs
  if (typeof model !== 'string' || model === '') {
    throw new RunnerError(`${path} needs a model`)
  }
  if (typeof workflow !== 'string' || workflow === '') {
    throw new RunnerError(`${path} needs a workflow`)
  }
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new RunnerError(`${path} needs an inputs object`)
  }
  const parsed: Record<string, AdapterBinding> = {}
  for (const [key, value] of Object.entries(inputs)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new RunnerError(`${path} input ${key} must be an object`)
    }
    const node = (value as { node?: unknown }).node
    const input = (value as { input?: unknown }).input
    const upload = (value as { upload?: unknown }).upload
    if (typeof node !== 'string' || typeof input !== 'string') {
      throw new RunnerError(`${path} input ${key} needs node and input`)
    }
    parsed[key] = { node, input, ...(upload === true ? { upload: true } : {}) }
  }
  return { model, workflow, inputs: parsed }
}

function resolveImage(path: string): string {
  const absolute = resolve(path)
  let info
  try {
    info = statSync(absolute)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new RunnerError(`cannot read ${absolute}: ${detail}`)
  }
  if (info.isFile()) return absolute
  if (!info.isDirectory())
    throw new RunnerError(`${absolute} is not a file or directory`)

  const images = readdirSync(absolute)
    .filter((name) => IMAGE_EXT.has(extname(name).toLowerCase()))
    .sort()
  const image = images[0]
  if (!image) throw new RunnerError(`no image in ${absolute}`)
  return join(absolute, image)
}
