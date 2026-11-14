import { RunnerError } from '../errors.ts'
import { relativePath } from '../path.ts'
import type { Prompt } from '../workflow/graph.ts'

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

export interface ComfyDeps {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  onPromptId?: (promptId: string) => void
}

export function workflowName(name: string): string {
  const parts = name.split('/')
  const bad = parts.some(
    (part) =>
      part === '' || part === '.' || part === '..' || part.includes('\\'),
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

  async writeWorkflow(
    name: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    const safe = workflowName(name)
    await this.request(
      `/userdata/${encodeURIComponent(`workflows/${safe}`)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      },
      { overwrite: 'true' },
    )
  }

  async listFiles(
    type: 'input' | 'output',
    signal?: AbortSignal,
  ): Promise<string[]> {
    const res = await this.request(`/internal/files/${type}`, { signal })
    const body: unknown = await res.json()
    if (!Array.isArray(body)) {
      throw new RunnerError('ComfyUI file list is not an array')
    }
    return body.map((item) => listedName(item, type))
  }

  async uploadBytes(
    bytes: Uint8Array,
    filename: string,
    subfolder: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(bytes)]), filename)
    form.append('overwrite', 'true')
    form.append('type', 'input')
    form.append('subfolder', subfolder)
    await this.request('/upload/image', { method: 'POST', body: form, signal })
  }

  async submitPrompt(prompt: Prompt, signal?: AbortSignal): Promise<string> {
    return this.submit(prompt, signal)
  }

  async promptHistory(
    promptId: string,
    signal?: AbortSignal,
  ): Promise<HistoryEntry | null> {
    return this.history(promptId, signal)
  }

  async cancelJob(promptId: string): Promise<boolean> {
    const res = await this.request(
      `/api/jobs/${encodeURIComponent(promptId)}/cancel`,
      {
        method: 'POST',
      },
    )
    const body = (await res.json()) as { cancelled?: unknown }
    return body.cancelled === true
  }

  async viewFile(
    type: string,
    subfolder: string,
    filename: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const res = await this.request(
      '/view',
      { signal },
      { filename, subfolder, type },
    )
    const raw = await res.arrayBuffer()
    return {
      bytes: new Uint8Array(raw),
      contentType:
        res.headers.get('content-type') ?? 'application/octet-stream',
    }
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
        // ComfyUI 在 Windows 上回传的 subfolder 用 \ 分隔，统一归一化成 /
        const subfolder =
          typeof record.subfolder === 'string'
            ? record.subfolder.replaceAll('\\', '/')
            : ''
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

function listedName(item: unknown, type: 'input' | 'output'): string {
  const suffix = ` [${type}]`
  if (typeof item !== 'string' || !item.endsWith(suffix)) {
    throw new RunnerError('ComfyUI file list has an invalid entry')
  }
  return relativePath(item.slice(0, -suffix.length))
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
