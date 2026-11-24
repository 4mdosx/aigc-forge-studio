import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, join } from 'node:path'

import type { TaskRow } from '../db.ts'
import { RunnerError } from '../errors.ts'
import { viewTarget } from '../path.ts'
import { storedPaths } from './records.ts'
import type { Runner } from './queue.ts'

// 产物文件的两个入口：清单（fileItems）与读取（readStoredFile）。
// 契约固定在这里，路由和 MCP 都只消费这两个函数，避免各自拼路径。

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
}

export interface FileItem {
  index: number
  name: string
  /** 完整相对路径（output/… ），也是唯一可靠的定位方式 */
  path: string
  /** 直接可用的下载地址，按序号定位，不含路径 */
  url: string
  /** 同上，但带 attachment，浏览器会存盘而不是预览 */
  downloadUrl: string
  contentType: string
  /** 已缓存到 runner 本地时才有真实字节数，否则 null */
  size: number | null
  /** 本地已有副本：ComfyUI 离线也能取到 */
  cached: boolean
}

export function contentTypeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export function localCopyPath(runner: Runner, path: string): string {
  return join(runner.dataDir, path)
}

interface LocalState {
  cached: boolean
  size: number | null
}

function localState(runner: Runner, path: string): LocalState {
  const abs = localCopyPath(runner, path)
  if (!existsSync(abs)) return { cached: false, size: null }
  try {
    return { cached: true, size: statSync(abs).size }
  } catch {
    return { cached: false, size: null }
  }
}

/**
 * 一个任务的全部产物，带可直接用的 url。
 * 未完成任务返回空数组；已完成但没记录产物（旧任务）也是空数组——
 * 调用方看 status 与 count 就知道是「还没好」还是「这条任务本来就没有图」。
 */
export function fileItems(runner: Runner, task: TaskRow): FileItem[] {
  return storedPaths(task).map((path, index) => {
    const state = localState(runner, path)
    return {
      index,
      name: path.split('/').pop() ?? path,
      path,
      url: `/tasks/${task.id}/files/${index}`,
      downloadUrl: `/tasks/${task.id}/files/${index}?download=1`,
      contentType: contentTypeOf(path),
      size: state.size,
      cached: state.cached,
    }
  })
}

/**
 * 把请求里的 selector 解析成产物表中的一条路径。三种写法都认：
 *   `0`                                 序号（清单里的 index）
 *   `character_00002_.png`              文件名，必须唯一
 *   `output/2026-11-24/gen-x/a.png`     完整路径
 * 解析不到就报错，并把可用的清单带上——不让调用方去猜。
 */
export function selectStoredPath(task: TaskRow, selector: string): string {
  const paths = storedPaths(task)
  if (paths.length === 0) {
    throw new RunnerError(
      `task ${task.id} has no output files (status=${task.status})`,
      404,
    )
  }
  const missing = () =>
    new RunnerError(
      `no file "${selector}" in task ${task.id}; available: ${paths
        .map((path, index) => `${index}=${path}`)
        .join(', ')}`,
      404,
    )

  if (/^\d+$/.test(selector)) {
    const path = paths[Number(selector)]
    if (path === undefined) throw missing()
    return path
  }
  if (paths.includes(selector)) {
    viewTarget(selector)
    return selector
  }

  const name = selector.split('/').pop() ?? selector
  const hits = paths.filter((path) => (path.split('/').pop() ?? '') === name)
  if (hits.length === 1) return hits[0] as string
  if (hits.length > 1) {
    throw new RunnerError(
      `file name "${name}" is ambiguous in task ${task.id} (${hits.length} matches); use index or full path`,
      400,
    )
  }

  // 以 output/ 开头但不在产物表里：路径本身合法，只是不属于这条任务
  if (selector.split('/')[0] === 'output') {
    throw new RunnerError(
      `path ${selector} does not belong to task ${task.id}`,
      400,
    )
  }
  throw missing()
}

export interface StoredFile {
  bytes: Uint8Array
  contentType: string
  etag: string
  size: number
  /** 本次是否命中了本地副本 */
  cached: boolean
}

/**
 * 读一个产物文件。顺序是「本地副本 → ComfyUI → 顺手存一份本地」。
 *
 * 这样下载不再依赖推理机在线：第一次请求会把字节复制到 data/output/<原路径>
 * （与审批通过时的复制位置一致），之后 ComfyUI 重启、清缓存都不影响已看过的图。
 * 单张 1MB 量级，代价可以接受；要强制回源用 refresh。
 */
export async function readStoredFile(
  runner: Runner,
  task: TaskRow,
  path: string,
  opts: { refresh?: boolean } = {},
): Promise<StoredFile> {
  const target = viewTarget(path)
  const abs = localCopyPath(runner, path)
  const contentType = contentTypeOf(path)

  if (!opts.refresh) {
    const local = readLocal(abs, contentType)
    if (local) return local
  }

  const client =
    runner.clients.find((item) => item.baseURL === task.comfy_base_url) ??
    runner.clients[0]
  if (!client) {
    throw new RunnerError(
      `no local copy of ${path} and no ComfyUI instance is configured`,
      503,
    )
  }

  let file: { bytes: Uint8Array; contentType: string }
  try {
    file = await client.viewFile(target.type, target.subfolder, target.filename)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    throw new RunnerError(
      `cannot read ${path} from ${client.baseURL}: ${why}`,
      502,
    )
  }

  // 落盘失败不影响这次响应：下次再缓存。先写临时名再 rename，
  // 避免并发请求读到写了一半的文件。内容没变就不动 mtime，
  // 否则 refresh 一次就让所有客户端的 ETag 失效。
  try {
    if (!sameBytes(abs, file.bytes)) {
      mkdirSync(dirname(abs), { recursive: true })
      const tmp = `${abs}.part-${process.pid}`
      writeFileSync(tmp, file.bytes)
      renameSync(tmp, abs)
    }
  } catch {
    // 只读挂载、磁盘满之类，忽略
  }

  return {
    bytes: file.bytes,
    contentType: file.contentType || contentType,
    etag: etagOf(abs, file.bytes.byteLength),
    size: file.bytes.byteLength,
    cached: false,
  }
}

function sameBytes(abs: string, bytes: Uint8Array): boolean {
  if (!existsSync(abs)) return false
  try {
    return readFileSync(abs).equals(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  } catch {
    return false
  }
}

function readLocal(abs: string, contentType: string): StoredFile | null {  if (!existsSync(abs)) return null
  try {
    const bytes = new Uint8Array(readFileSync(abs))
    return {
      bytes,
      contentType,
      etag: etagOf(abs, bytes.byteLength),
      size: bytes.byteLength,
      cached: true,
    }
  } catch {
    return null
  }
}

// 弱 ETag：大小 + mtime。图片不会被原地改写，够用且不用每次算哈希。
function etagOf(abs: string, size: number): string {
  let mtime = 0
  try {
    mtime = Math.floor(statSync(abs).mtimeMs)
  } catch {
    mtime = 0
  }
  return `W/"${size}-${mtime}"`
}
