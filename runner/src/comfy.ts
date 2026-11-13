import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { RunnerError } from './errors.ts'
import type { Prompt } from './workflow.ts'

export interface RemoteFile {
  nodeId: string
  filename: string
  subfolder: string
  type: string
}

export interface HistoryEntry {
  outputs?: Record<string, Record<string, unknown>>
  status?: {
    status_str?: string
    completed?: boolean
    messages?: unknown[]
  }
}

export interface RunResult {
  promptId: string
  files: string[]
}

export interface ComfyDeps {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  onPromptId?: (promptId: string) => void
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
}

export function workflowName(name: string): string {
  const parts = name.split('/')
  const bad = parts.some(
    (part) => part === '' || part === '.' || part === '..' || part.includes('\\'),
  )
  if (bad) throw new RunnerError('invalid workflow name')
  if (!name.toLowerCase().endsWith('.json')) {
    throw new RunnerError('workflow name must end with .json')
  }
  return name
}

export class ComfyClient {
  readonly baseURL: string
  private readonly deps: ComfyDeps

  constructor(baseURL: string, deps: ComfyDeps = {}) {
    this.baseURL = baseURL
    this.deps = deps
  }

  async upload(filePath: string): Promise<string> {
    const bytes = await readFile(filePath)
    const form = new FormData()
    form.append(
      'image',
      new Blob([bytes], { type: mimeType(filePath) }),
      fileName(filePath),
    )
    form.append('overwrite', 'true')
    form.append('type', 'input')

    const res = await this.request('/upload/image', {
      method: 'POST',
      body: form,
    })
    const body = (await res.json()) as { name?: unknown; subfolder?: unknown }
    if (typeof body.name !== 'string' || body.name === '') {
      throw new RunnerError(`upload failed for ${filePath}`)
    }
    return typeof body.subfolder === 'string' && body.subfolder !== ''
      ? `${body.subfolder}/${body.name}`
      : body.name
  }

  async workflows(signal?: AbortSignal): Promise<string[]> {
    const res = await this.request(
      '/userdata',
      { signal },
      { dir: 'workflows', recurse: 'true' },
    )
    const body: unknown = await res.json()
    if (!Array.isArray(body)) {
      throw new RunnerError('ComfyUI workflow list is not an array')
    }
    const names: string[] = []
    for (const item of body) {
      if (typeof item !== 'string' || item === '') {
        throw new RunnerError('ComfyUI workflow list has an invalid entry')
      }
      if (item.toLowerCase().endsWith('.json')) names.push(item)
    }
    names.sort()
    return names
  }

  async workflow(name: string, signal?: AbortSignal): Promise<unknown> {
    const safe = workflowName(name)
    const res = await this.request(
      `/userdata/${encodeURIComponent(`workflows/${safe}`)}`,
      { signal },
    )
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new RunnerError(`${safe} is not JSON`)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new RunnerError(`${safe} is not a workflow object`)
    }
    return body
  }

  async run(
    prompt: Prompt,
    outDir: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const promptId = await this.submit(prompt, signal)
    this.deps.onPromptId?.(promptId)
    const entry = await pollUntilDone({
      timeoutMs,
      signal,
      poll: () => this.history(promptId, signal),
      sleep: this.deps.sleep,
      now: this.deps.now,
      onGiveUp: async () => {
        await this.cancel(promptId).catch(() => undefined)
      },
    })

    assertSuccess(entry)
    const remote = filesFromHistory(entry)
    if (remote.length === 0)
      throw new RunnerError('workflow finished with no output files')

    await mkdir(outDir, { recursive: true })
    const files: string[] = []
    for (const file of remote) {
      const bytes = await this.download(file, signal)
      const dest = outputPath(outDir, file.subfolder, file.filename)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, bytes)
      files.push(dest)
    }
    return { promptId, files }
  }

  private async submit(prompt: Prompt, signal?: AbortSignal): Promise<string> {
    const res = await this.request('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal,
    })
    const body = (await res.json()) as { prompt_id?: unknown }
    if (typeof body.prompt_id !== 'string' || body.prompt_id === '') {
      throw new RunnerError('ComfyUI did not return a prompt_id')
    }
    return body.prompt_id
  }

  private async history(
    promptId: string,
    signal?: AbortSignal,
  ): Promise<HistoryEntry | null> {
    const res = await this.request(`/history/${encodeURIComponent(promptId)}`, {
      signal,
    })
    const body = (await res.json()) as Record<string, unknown>
    const wrapped = body[promptId]
    if (isHistoryEntry(wrapped)) return wrapped
    if (isHistoryEntry(body)) return body
    return null
  }

  private async download(
    file: RemoteFile,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const res = await this.request(
      '/view',
      { signal },
      { filename: file.filename, subfolder: file.subfolder, type: file.type },
    )
    return new Uint8Array(await res.arrayBuffer())
  }

  private async cancel(promptId: string): Promise<void> {
    await this.request(`/api/jobs/${encodeURIComponent(promptId)}/cancel`, {
      method: 'POST',
    })
  }

  private async request(
    path: string,
    init?: RequestInit,
    query?: Record<string, string>,
  ): Promise<Response> {
    const url = endpoint(this.baseURL, path, query)
    const fetchImpl = this.deps.fetch ?? fetch
    let res: Response
    try {
      res = await fetchImpl(url, init)
    } catch (err) {
      if (init?.signal?.aborted) throw new RunnerError('interrupted')
      throw new RunnerError(`cannot reach ${this.baseURL}: ${messageOf(err)}`)
    }
    if (!res.ok) throw new RunnerError(await errorText(res))
    return res
  }
}

export async function pollUntilDone(opts: {
  poll: () => Promise<HistoryEntry | null>
  timeoutMs: number
  intervalMs?: number
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  onGiveUp?: () => Promise<void>
}): Promise<HistoryEntry> {
  const interval = opts.intervalMs ?? 1000
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => delay(ms, opts.signal))
  const start = now()

  for (;;) {
    if (opts.signal?.aborted) {
      await opts.onGiveUp?.()
      throw new RunnerError('interrupted')
    }

    let entry: HistoryEntry | null
    try {
      entry = await opts.poll()
    } catch (err) {
      if (opts.signal?.aborted) {
        await opts.onGiveUp?.()
        throw new RunnerError('interrupted')
      }
      throw err
    }

    if (entry) return entry
    if (now() - start >= opts.timeoutMs) {
      await opts.onGiveUp?.()
      throw new RunnerError(`timed out after ${opts.timeoutMs / 1000}s`)
    }
    await sleep(interval)
  }
}

export function filesFromHistory(entry: HistoryEntry): RemoteFile[] {
  const seen = new Set<string>()
  const files: RemoteFile[] = []
  for (const [nodeId, nodeOut] of Object.entries(entry.outputs ?? {})) {
    if (!nodeOut || typeof nodeOut !== 'object') continue
    for (const value of Object.values(nodeOut)) {
      if (!Array.isArray(value)) continue
      for (const item of value) {
        if (!item || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        if (
          typeof record.filename !== 'string' ||
          typeof record.type !== 'string'
        )
          continue
        const subfolder =
          typeof record.subfolder === 'string' ? record.subfolder : ''
        const key = `${record.type}\0${subfolder}\0${record.filename}`
        if (seen.has(key)) continue
        seen.add(key)
        files.push({
          nodeId,
          filename: record.filename,
          subfolder,
          type: record.type,
        })
      }
    }
  }
  return files
}

export function assertSuccess(entry: HistoryEntry): void {
  if (entry.status?.status_str !== 'error') return
  const messages = entry.status.messages ?? []
  for (const message of messages) {
    if (!Array.isArray(message) || message[0] !== 'execution_error') continue
    const data = message[1]
    if (!data || typeof data !== 'object') break
    const record = data as Record<string, unknown>
    const where = [record.node_type, record.node_id]
      .filter((part) => typeof part === 'string')
      .join(' ')
    const text =
      typeof record.exception_message === 'string'
        ? record.exception_message
        : 'execution error'
    throw new RunnerError(where ? `${where}: ${text}` : text)
  }
  throw new RunnerError('execution error')
}

export function outputPath(
  outDir: string,
  subfolder: string,
  filename: string,
): string {
  const parts = subfolder.split(/[\\/]+/).filter((part) => part.length > 0)
  for (const part of parts) {
    if (part === '.' || part === '..')
      throw new RunnerError(`bad subfolder: ${subfolder}`)
  }
  return join(outDir, ...parts, fileName(filename))
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as HistoryEntry
  return entry.outputs !== undefined || entry.status !== undefined
}

function endpoint(
  baseURL: string,
  path: string,
  query?: Record<string, string>,
): string {
  const url = new URL(
    path.replace(/^\//, ''),
    baseURL.endsWith('/') ? baseURL : `${baseURL}/`,
  )
  if (query) {
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value)
  }
  return url.toString()
}

function mimeType(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : ''
  return MIME[ext] ?? 'application/octet-stream'
}

function fileName(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (!name || name === '.' || name === '..')
    throw new RunnerError(`bad filename: ${filePath}`)
  return name
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text()
  if (!text) return `HTTP ${res.status}`
  try {
    const body = JSON.parse(text) as {
      error?: { message?: string; details?: string } | string
      node_errors?: unknown
    }
    const error = body.error
    const message =
      typeof error === 'string'
        ? error
        : (error?.message ?? `HTTP ${res.status}`)
    const details =
      typeof error === 'object' && error?.details ? `: ${error.details}` : ''
    const nodeErrors = body.node_errors
    const nodes =
      nodeErrors &&
      typeof nodeErrors === 'object' &&
      Object.keys(nodeErrors).length > 0
        ? `\n${JSON.stringify(nodeErrors, null, 2)}`
        : ''
    return `${message}${details}${nodes}`
  } catch {
    return text
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
