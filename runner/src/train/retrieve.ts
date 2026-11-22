import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// 产物回程：把训练机 trainer 上的 LoRA 权重拉回 Mac 控制台的 data/lora/<job>/，
// 同时推一份到训练机 models/loras/ 让 ComfyUI 可见，最后落 manifest.json 作为
// 「已回程」的真相源。语义对齐 scripts_and_tools/train_animagine.mjs 的收尾段，
// 区别是走 runner API、异步执行，不再依赖终端脚本。

export interface LoraFile {
  file: string
  size: number
  sha256: string
}

export interface LoraManifest {
  jobId: string
  name: string
  baseModel: string | null
  trigger: string | null
  deployedAt: string
  files: LoraFile[]
}

export interface RetrieveState {
  jobId: string
  name: string | null
  status: 'idle' | 'running' | 'done' | 'error'
  phase: string
  done: number
  total: number
  files: LoraFile[]
  error: string | null
  startedAt: string
  finishedAt: string | null
  localDir: string | null
}

export function initialState(jobId: string): RetrieveState {
  return {
    jobId,
    name: null,
    status: 'idle',
    phase: '',
    done: 0,
    total: 0,
    files: [],
    error: null,
    startedAt: '',
    finishedAt: null,
    localDir: null,
  }
}

// job.name 来自 trainer，但仍是外部输入；只允许安全字符，挡住 ../ 之类。
export function safeJobName(name: unknown): string {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
    throw new Error(`非法训练任务名: ${String(name)}`)
  }
  return name
}

export function loraDirOf(dataDir: string, name: string): string {
  return join(dataDir, 'lora', safeJobName(name))
}

export function manifestPathOf(dataDir: string, name: string): string {
  return join(loraDirOf(dataDir, name), 'manifest.json')
}

export async function readManifest(
  dataDir: string,
  name: string,
): Promise<LoraManifest | null> {
  try {
    const raw = await readFile(manifestPathOf(dataDir, name), 'utf8')
    const value = JSON.parse(raw) as LoraManifest
    if (typeof value?.jobId !== 'string' || !Array.isArray(value.files)) return null
    return value
  } catch {
    return null
  }
}

// 已有 manifest 且指向同一 job、文件都在磁盘上 → 视作已回程，不重复拉 1GB。
export async function retrievedManifest(
  dataDir: string,
  jobId: string,
  name: string,
): Promise<LoraManifest | null> {
  const manifest = await readManifest(dataDir, name)
  if (!manifest || manifest.jobId !== jobId) return null
  const dir = loraDirOf(dataDir, name)
  for (const item of manifest.files) {
    if (basename(item.file) !== item.file) return null
    try {
      const info = await stat(join(dir, item.file))
      if (info.size !== item.size) return null
    } catch {
      return null
    }
  }
  return manifest
}

// runner 重启后内存状态丢失：从 data/lora/*/manifest.json 反查 jobId 找回「已回程」。
export async function findRetrievedByJobId(
  dataDir: string,
  jobId: string,
): Promise<{ name: string; manifest: LoraManifest } | null> {
  const root = join(dataDir, 'lora')
  let names: string[] = []
  try {
    names = await readdir(root)
  } catch {
    return null
  }
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) continue
    const found = await retrievedManifest(dataDir, jobId, name)
    if (found) return { name, manifest: found }
  }
  return null
}

// 与 train_animagine.mjs.discoverArtifacts 同序：epoch 权重在前，final 收尾。
// 候选靠 HEAD 探测，不假设 trainer 有目录列举端点。
export function artifactCandidates(params: Record<string, unknown>, name: string): string[] {
  const epochs = Math.max(1, Math.min(100, Number(params.maxTrainEpochs) || 1))
  const every = Math.max(1, Math.min(epochs, Number(params.saveEveryNEpochs) || 1))
  const out: string[] = []
  for (let i = every; i <= epochs; i += every) {
    out.push(`${name}-${String(i).padStart(6, '0')}.safetensors`)
  }
  out.push(`${name}.safetensors`)
  return out
}

export function trainerFilesURL(base: string, root: string, path: string): string {
  return `${base}/files?root=${root}&path=${encodeURIComponent(path)}`
}

export async function discoverArtifacts(
  base: string,
  name: string,
  candidates: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const found: string[] = []
  for (const file of candidates) {
    try {
      const res = await fetch(trainerFilesURL(base, 'training', `${name}/output/${file}`), {
        method: 'HEAD',
        signal,
      })
      if (res.ok) found.push(file)
    } catch {
      // 单个探测失败不当成致命：网络抖动时后面的正式下载会再报错。
    }
  }
  return found
}

async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size
}

export interface RetrieveOptions {
  trainerBaseURL: string
  dataDir: string
  jobId: string
  name: string
  params: Record<string, unknown>
  // 部署到 ComfyUI：推一份到 trainer 的 models/loras。默认开。
  deploy?: boolean
  onProgress?: (phase: string, done: number, total: number) => void
  signal?: AbortSignal
}

// 整段流程：探测 → 逐个流式拉回（.part 完成后 rename）→ 推 models/loras → 写 manifest。
// 中途失败时 .part 留着方便续传排查，但不会写进 manifest，下次会重新拉。
export async function retrieveArtifacts(options: RetrieveOptions): Promise<LoraManifest> {
  const { trainerBaseURL, dataDir, jobId, name, params, signal } = options
  const deploy = options.deploy !== false
  const progress = options.onProgress ?? (() => {})
  const dir = loraDirOf(dataDir, name)
  await mkdir(dir, { recursive: true })

  const candidates = artifactCandidates(params, name)
  progress('探测权重文件', 0, candidates.length)
  const files = await discoverArtifacts(trainerBaseURL, name, candidates, signal)
  if (files.length === 0) {
    throw new Error(`训练输出 ${name}/output 里没找到 safetensors（探测 ${candidates.length} 个候选）`)
  }

  const artifacts: LoraFile[] = []
  for (const [index, file] of files.entries()) {
    progress(`拉取 ${file}`, index, files.length)
    const remote = trainerFilesURL(trainerBaseURL, 'training', `${name}/output/${file}`)
    const res = await fetch(remote, { signal })
    if (!res.ok || !res.body) {
      throw new Error(`拉取 ${file}: HTTP ${res.status}`)
    }
    const part = join(dir, `${file}.part`)
    const hash = createHash('sha256')
    let size = 0
    await pipeline(
      Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream),
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          hash.update(chunk)
          size += chunk.length
          yield chunk
        }
      },
      createWriteStream(part, { flags: 'w' }),
    )
    const local = join(dir, file)
    await rename(part, local)
    const localHash = hash.digest('hex')

    let sha256 = localHash
    if (deploy) {
      progress(`部署 ${file} → models/loras`, index, files.length)
      const up = await fetch(
        `${trainerBaseURL}/upload?root=models&path=${encodeURIComponent(`loras/${file}`)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: createReadStream(local),
          duplex: 'half',
          signal,
        } as unknown as RequestInit,
      )
      if (!up.ok) {
        throw new Error(
          `部署 ${file} 到 models/loras 失败: HTTP ${up.status} ${(await up.text()).slice(0, 200)}（本地已拉回 ${local}）`,
        )
      }
      const info = (await up.json()) as { size?: number; sha256?: string }
      if (typeof info.sha256 === 'string') sha256 = info.sha256
    }

    artifacts.push({ file, size: size || (await fileSize(local)), sha256 })
    progress(`完成 ${file}`, index + 1, files.length)
  }

  const manifest: LoraManifest = {
    jobId,
    name,
    baseModel: typeof params.baseModel === 'string' ? params.baseModel : null,
    // job.params 不带触发词（trainer 白名单不收），触发词在 job name 里也无可靠逆解。
    trigger: null,
    deployedAt: new Date().toISOString(),
    files: artifacts,
  }
  const target = manifestPathOf(dataDir, name)
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  await rename(tmp, target)
  return manifest
}

// 失败清理只删 .part，不碰已完成的权重与 manifest。
export async function cleanPartials(dataDir: string, name: string): Promise<void> {
  const dir = loraDirOf(dataDir, name)
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const file of names) {
    if (!file.endsWith('.safetensors.part')) continue
    try {
      await unlink(join(dir, file))
    } catch {
      // 清理失败不影响主流程
    }
  }
}
