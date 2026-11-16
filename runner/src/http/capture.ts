import { execFile as execFileCb } from 'node:child_process'
import { randomInt } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { Hono } from 'hono'

import { RunnerError } from '../errors.ts'
import { relativePath } from '../path.ts'
import type { Runner } from '../task/queue.ts'
import { bytesOf, jsonObject, stringField } from './request.ts'

const execFile = promisify(execFileCb)

// 采集工作台：Pinterest 链接 → 下载原图 → 异步预处理 → 手工整理素材池。
// 目录即真相源（folder = data/capture 一级目录，不进 SQLite）：
//   data/capture/<folder>/raw/<id>.<ext>    原图（尽量提升到 i.pinimg originals 分辨率）
//   data/capture/<folder>/image/<id>.jpg    预处理产物（jpeg q88，长边 ≤3072）
//   data/capture/<folder>/image/<id>.json   sidecar meta（source/status/尺寸/record）
// 条目 id 形如 20261116-185112-a1b2，删除/整理不设端点——手工在文件系统做。

const FOLDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const KINDS = ['raw', 'image'] as const
const MAX_EDGE = 3072
const JPEG_QUALITY = 88
const MIN_IMAGE_BYTES = 1000
// pin.it 短链在国内直连不稳：先直连，失败走本地代理（可用 CAPTURE_PROXY 覆盖）
const PROXY = process.env.CAPTURE_PROXY ?? 'http://127.0.0.1:7897'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15'
const CURL_SECONDS = 45

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

// 预处理中的条目（进程内）。重启后不在集合里的 processing 条目按中断处理
const inflight = new Set<string>()

// ---- 纯函数（测试覆盖） ----

export function isFolderName(name: string): boolean {
  return FOLDER_RE.test(name)
}

// 链接归一：i.pinimg.com 直链 → image，其余 pinterest/pin.it → page。剥 query 与 hash
export function normalizeCaptureUrl(input: string): {
  kind: 'image' | 'page'
  url: string
} {
  const trimmed = input.trim()
  if (trimmed === '') throw new RunnerError('url is required')
  let url = trimmed
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new RunnerError('invalid url')
  }
  const host = parsed.hostname.toLowerCase()
  const pinimg = /(^|\.)pinimg\.com$/.test(host)
  const pin = /(^|\.)pinterest\.[a-z.]+$/.test(host) || host === 'pin.it' || host.endsWith('.pin.it')
  if (!pinimg && !pin) {
    throw new RunnerError('只支持 pinterest.com / pin.it / i.pinimg.com 链接')
  }
  parsed.hash = ''
  parsed.search = ''
  return { kind: pinimg ? 'image' : 'page', url: parsed.toString() }
}

// 已解析图片直链的校验（Chrome 插件等调用方直传 mediaUrl 时用）
export function normalizeMediaUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') throw new RunnerError('mediaUrl is empty')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new RunnerError('invalid mediaUrl')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new RunnerError('mediaUrl must be http(s)')
  }
  parsed.hash = ''
  return parsed.toString()
}

// og:image 提取（property 前置/后置两种排版都试）
export function ogImageOf(html: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
  ]
  for (const re of patterns) {
    const hit = re.exec(html)
    if (hit?.[1]) return hit[1].replace(/&amp;/g, '&')
  }
  return null
}

// i.pinimg.com 缩略版本 → originals 版本；已是 originals 或非 pinimg 返回 null
export function originalsOf(url: string): string | null {
  const hit = /^(https:\/\/i\.pinimg\.com\/)(\d+x\d*|originals)\/(.+)$/i.exec(url)
  if (!hit) return null
  if ((hit[2] ?? '').toLowerCase() === 'originals') return null
  return `${hit[1]}originals/${hit[3]}`
}

export function extOf(url: string): string {
  const hit = /\.(jpe?g|png|gif|webp|bmp)(?:[?#].*)?$/i.exec(url)
  return hit ? `.${(hit[1] ?? 'jpg').toLowerCase()}` : '.jpg'
}

export function captureId(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  let rand = ''
  for (let index = 0; index < 4; index += 1) {
    rand += alphabet[randomInt(alphabet.length)]
  }
  return `${stamp}-${rand}`
}

// oEmbed 响应解析：活 pin 给 thumbnail_url（236x 小图，由 originals 提升链接力）
export function oembedThumbnailOf(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const thumb = (parsed as Record<string, unknown>).thumbnail_url
  return typeof thumb === 'string' && thumb !== '' ? thumb : null
}

// oEmbed 明确报错（如 "Url was not found"）时提取错误文本，区分死 pin 与其他故障
export function oembedErrorOf(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const error = (parsed as Record<string, unknown>).error
  return typeof error === 'string' && error !== '' ? error : null
}

// ---- 下载（curl 直连 → 代理回退） ----

function curlMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function curlRun(args: string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await execFile('curl', args, {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    })
    return stdout
  } catch (err) {
    // --fail-with-body 下 HTTP 错误的响应体在 stdout，不能扔
    const stdout = (err as { stdout?: unknown }).stdout
    if (typeof stdout === 'string' && stdout !== '') return stdout
    throw err
  }
}

// 抓文本（pin 页 HTML / oEmbed JSON）。--fail-with-body 保留 4xx/5xx 响应体，错误可读
async function fetchPage(url: string): Promise<string> {
  const base = ['-sS', '-L', '--fail-with-body', '--compressed', '--max-filesize', '16777216', '-A', UA]
  const seconds = CURL_SECONDS
  const timeoutMs = (seconds + 10) * 1000
  let first = ''
  try {
    return await curlRun([...base, '--max-time', String(seconds), url], timeoutMs)
  } catch (err) {
    first = curlMessage(err)
  }
  try {
    return await curlRun(
      [...base, '--max-time', String(seconds), '--proxy', PROXY, url],
      timeoutMs,
    )
  } catch (err) {
    throw new RunnerError(
      `下载页面失败（直连：${first} / 代理：${curlMessage(err)}）`,
      502,
    )
  }
}

// 下文件到 dest.part，成功后改名 dest（防半截文件）
async function downloadTo(
  url: string,
  dest: string,
  referer?: string,
): Promise<void> {
  const base = [
    '-sS',
    '-L',
    '--fail',
    '--max-filesize',
    '52428800',
    '-A',
    UA,
    ...(referer ? ['-e', referer] : []),
    '-o',
    `${dest}.part`,
  ]
  const timeoutMs = (CURL_SECONDS + 10) * 1000
  let first = ''
  try {
    await curlRun([...base, '--max-time', String(CURL_SECONDS), url], timeoutMs)
  } catch (err) {
    first = curlMessage(err)
  }
  if (first !== '') {
    try {
      await curlRun(
        [...base, '--max-time', String(CURL_SECONDS), '--proxy', PROXY, url],
        timeoutMs,
      )
    } catch (err) {
      rmSync(`${dest}.part`, { force: true })
      throw new RunnerError(
        `下载图片失败（直连：${first} / 代理：${curlMessage(err)}）`,
        502,
      )
    }
  }
  renameSync(`${dest}.part`, dest)
}

// ---- 内部工具 ----

function captureRoot(dataDir: string): string {
  return join(dataDir, 'capture')
}

function assertFolderDir(dataDir: string, folder: string): string {
  if (!isFolderName(folder)) throw new RunnerError('invalid folder name')
  const dir = join(captureRoot(dataDir), folder)
  if (!existsSync(dir)) throw new RunnerError(`folder not found: ${folder}`, 404)
  return dir
}

function ensureEntryDirs(dir: string): void {
  mkdirSync(join(dir, 'raw'), { recursive: true })
  mkdirSync(join(dir, 'image'), { recursive: true })
}

function metaPathOf(dir: string, id: string): string {
  return join(dir, 'image', `${id}.json`)
}

function readMeta(dir: string, id: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(metaPathOf(dir, id), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function writeMeta(
  dir: string,
  id: string,
  meta: Record<string, unknown>,
): void {
  mkdirSync(join(dir, 'image'), { recursive: true })
  writeFileSync(metaPathOf(dir, id), JSON.stringify(meta, null, 2))
}

// 页面/短链 → 图片 URL。og:image 优先，oEmbed 兜底（死 pin 会明确报 not found）
async function resolveMediaUrl(input: string): Promise<string> {
  const { kind, url } = normalizeCaptureUrl(input)
  if (kind === 'image') return url

  const problems: string[] = []
  try {
    const html = await fetchPage(url)
    const og = ogImageOf(html)
    if (og) return og
    problems.push('页面无 og:image')
  } catch (err) {
    problems.push(`页面抓取失败：${curlMessage(err)}`)
  }

  try {
    const text = await fetchPage(
      `https://www.pinterest.com/oembed.json?url=${encodeURIComponent(url)}`,
    )
    const oembedError = oembedErrorOf(text)
    if (oembedError && /not found/i.test(oembedError)) {
      throw new RunnerError(
        'pin 已被删除、设为私密，或对当前网络不可见（Pinterest 返回 Url was not found）',
        422,
      )
    }
    const thumbnail = oembedThumbnailOf(text)
    if (thumbnail) return thumbnail
    problems.push(oembedError ? `oEmbed：${oembedError}` : 'oEmbed 无 thumbnail_url')
  } catch (err) {
    if (err instanceof RunnerError) throw err
    problems.push(`oEmbed 失败：${curlMessage(err)}`)
  }

  throw new RunnerError(
    `无法解析出图片（${problems.join('；')}）。链接可能已失效或需要登录`,
    422,
  )
}

// 读尺寸；读不出来当超限处理（宁可重采样也不冒放大险）
async function overMaxEdge(file: string): Promise<boolean> {
  try {
    const { stdout } = await execFile('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file])
    const width = Number(/pixelWidth: (\d+)/.exec(stdout)?.[1]) || 0
    const height = Number(/pixelHeight: (\d+)/.exec(stdout)?.[1]) || 0
    return Math.max(width, height) > MAX_EDGE
  } catch {
    return true
  }
}

// 异步预处理：originals 提升 → sips 转 jpeg（只缩不放，长边 ≤3072）→ 尺寸 → meta 收尾
async function processEntry(
  folder: string,
  id: string,
  mediaUrl: string,
  paths: { dir: string; rawAbs: string; imageAbs: string },
): Promise<void> {
  const key = `${folder}/${id}`
  inflight.add(key)
  try {
    // folder 在预处理期间被删/改名：老路径不存在就放弃，避免 mkdirSync 造出幽灵目录
    if (!existsSync(paths.dir)) return
    const meta = readMeta(paths.dir, id) ?? { id, folder, status: 'processing' }
    let record = /\/originals\//i.test(mediaUrl) ? 'originals' : 'og'
    const upgrade = originalsOf(mediaUrl)
    if (upgrade) {
      try {
        await downloadTo(upgrade, paths.rawAbs, 'https://www.pinterest.com/')
        record = 'originals'
      } catch {
        // originals 不存在（相当常见），保留保底版本继续
      }
    }
    await execFile(
      'sips',
      [
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        String(JPEG_QUALITY),
        // 只缩不放：raw 尺寸读出来后，超过长边上限才加 -Z
        ...(await overMaxEdge(paths.rawAbs) ? ['-Z', String(MAX_EDGE)] : []),
        paths.rawAbs,
        '--out',
        paths.imageAbs,
      ],
      { timeout: 60_000 },
    )
    let width: number | null = null
    let height: number | null = null
    try {
      const { stdout } = await execFile('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', paths.imageAbs])
      width = Number(/pixelWidth: (\d+)/.exec(stdout)?.[1]) || null
      height = Number(/pixelHeight: (\d+)/.exec(stdout)?.[1]) || null
    } catch {
      // 尺寸读取失败不影响产物
    }
    writeMeta(paths.dir, id, {
      ...meta,
      status: 'done',
      record,
      width,
      height,
      processedAt: new Date().toISOString(),
    })
  } catch (err) {
    const meta = readMeta(paths.dir, id) ?? { id, folder }
    writeMeta(paths.dir, id, {
      ...meta,
      status: 'failed',
      error: curlMessage(err),
    })
  } finally {
    inflight.delete(key)
  }
}

// ---- 端点 ----

export function mountCapture(app: Hono, runner: Runner): void {
  // folder 列表（目录即真相源）
  app.get('/capture/folders', (c) => {
    const root = captureRoot(runner.dataDir)
    const folders: Array<{ name: string; done: number; processing: number }> = []
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        if (name.startsWith('_') || name.startsWith('.')) continue
        if (!isFolderName(name)) continue
        const dir = join(root, name)
        try {
          if (!statSync(dir).isDirectory()) continue
        } catch {
          continue
        }
        let done = 0
        let processing = 0
        const imageDir = join(dir, 'image')
        if (existsSync(imageDir)) {
          for (const file of readdirSync(imageDir)) {
            if (file.endsWith('.jpg')) done += 1
          }
          for (const file of readdirSync(imageDir)) {
            if (!file.endsWith('.json')) continue
            const meta = readMeta(dir, file.slice(0, -5))
            if (meta?.status === 'processing') processing += 1
          }
        }
        folders.push({ name, done, processing })
      }
    }
    folders.sort((a, b) => a.name.localeCompare(b.name))
    return c.json({ folders })
  })

  app.post('/capture/folders', async (c) => {
    const body = await jsonObject(c.req)
    const name = stringField(body, 'name').trim().toLowerCase()
    if (!isFolderName(name)) {
      throw new RunnerError(
        'folder 名只允许小写字母、数字、连字符与下划线（字母或数字开头，≤64 字符）',
      )
    }
    const dir = join(captureRoot(runner.dataDir), name)
    if (existsSync(dir)) {
      throw new RunnerError(`folder already exists: ${name}`, 409)
    }
    ensureEntryDirs(dir)
    return c.json({ name }, 201)
  })

  app.post('/capture/folders/rename', async (c) => {
    const body = await jsonObject(c.req)
    const from = stringField(body, 'from').trim()
    const to = stringField(body, 'to').trim().toLowerCase()
    if (!isFolderName(to)) {
      throw new RunnerError('新 folder 名只允许小写字母、数字、连字符与下划线')
    }
    const source = assertFolderDir(runner.dataDir, from)
    const target = join(captureRoot(runner.dataDir), to)
    if (existsSync(target)) {
      throw new RunnerError(`folder already exists: ${to}`, 409)
    }
    renameSync(source, target)
    return c.json({ from, to }, 201)
  })

  // 提交 Pinterest 链接：同步完成 og:image 保底下载（图片先落 folder），预处理异步
  app.post('/capture/pins', async (c) => {
    const body = await jsonObject(c.req)
    const url = stringField(body, 'url')
    const folder = stringField(body, 'folder')
    const dir = assertFolderDir(runner.dataDir, folder)
    ensureEntryDirs(dir)

    const mediaUrl =
      typeof body.mediaUrl === 'string' && body.mediaUrl !== ''
        ? normalizeMediaUrl(body.mediaUrl)
        : await resolveMediaUrl(url)
    const id = captureId(runner.now())
    const rawAbs = join(dir, 'raw', `${id}${extOf(mediaUrl)}`)
    await downloadTo(mediaUrl, rawAbs, 'https://www.pinterest.com/')
    if (statSync(rawAbs).size < MIN_IMAGE_BYTES) {
      rmSync(rawAbs, { force: true })
      throw new RunnerError('下载的内容不是有效图片', 502)
    }
    writeMeta(dir, id, {
      id,
      folder,
      source: url,
      mediaUrl,
      status: 'processing',
      record: /\/originals\//i.test(mediaUrl) ? 'originals' : 'og',
      createdAt: runner.now().toISOString(),
    })
    void processEntry(folder, id, mediaUrl, { dir, rawAbs, imageAbs: join(dir, 'image', `${id}.jpg`) })
    return c.json({ id, folder, status: 'processing' }, 201)
  })

  // 条目列表（状态从 sidecar meta 推断；重启中断的 processing 标为 failed）
  app.get('/capture/items', (c) => {
    const folder = c.req.query('folder') ?? ''
    const dir = assertFolderDir(runner.dataDir, folder)
    const rawDir = join(dir, 'raw')
    const imageDir = join(dir, 'image')

    const rawById = new Map<string, string>()
    if (existsSync(rawDir)) {
      for (const file of readdirSync(rawDir)) {
        if (file.startsWith('.') || !FILENAME_RE.test(file)) continue
        const dot = file.lastIndexOf('.')
        if (dot > 0) rawById.set(file.slice(0, dot), file)
      }
    }
    const metas = new Map<string, Record<string, unknown>>()
    if (existsSync(imageDir)) {
      for (const file of readdirSync(imageDir)) {
        if (!file.endsWith('.json')) continue
        const meta = readMeta(dir, file.slice(0, -5))
        const id = typeof meta?.id === 'string' ? meta.id : file.slice(0, -5)
        metas.set(id, meta ?? {})
      }
    }

    const ids = new Set<string>([...rawById.keys(), ...metas.keys()])
    const items = []
    for (const id of ids) {
      const meta = metas.get(id) ?? {}
      let status = String(meta.status ?? 'processing')
      let error = typeof meta.error === 'string' ? meta.error : null
      if (status === 'processing' && !inflight.has(`${folder}/${id}`)) {
        status = 'failed'
        error = '预处理被中断（runner 重启）；raw 原图仍在，可手工处理'
      }
      const rawFile = rawById.get(id) ?? null
      const imageFile = existsSync(join(imageDir, `${id}.jpg`)) ? `${id}.jpg` : null
      items.push({
        id,
        status,
        error,
        source: meta.source ?? null,
        record: meta.record ?? null,
        width: meta.width ?? null,
        height: meta.height ?? null,
        createdAt: meta.createdAt ?? null,
        rawUrl: rawFile ? `/capture/file/${folder}/raw/${rawFile}` : null,
        imageUrl: imageFile ? `/capture/file/${folder}/image/${imageFile}` : null,
      })
    }
    items.sort((a, b) => String(b.id).localeCompare(String(a.id)))
    return c.json({ total: items.length, items })
  })

  // 图片服务：/capture/file/<folder>/<raw|image>/<filename>
  app.get('/capture/file/*', (c) => {
    const path = relativePath(c.req.path.slice('/capture/file/'.length))
    const parts = path.split('/')
    if (parts.length !== 3) throw new RunnerError('invalid capture file path')
    const [folder, kind, filename] = parts as [string, string, string]
    if (!isFolderName(folder)) throw new RunnerError('invalid folder name')
    if (!(KINDS as readonly string[]).includes(kind)) {
      throw new RunnerError('kind must be raw or image')
    }
    if (!FILENAME_RE.test(filename) || filename.includes('..')) {
      throw new RunnerError('invalid filename')
    }
    const dot = filename.lastIndexOf('.')
    if (dot <= 0) throw new RunnerError('invalid filename')
    const ext = filename.slice(dot).toLowerCase()
    const abs = join(captureRoot(runner.dataDir), folder, kind, filename)
    if (!existsSync(abs)) throw new RunnerError('file not found', 404)
    return c.body(bytesOf(readFileSync(abs)) as ArrayBuffer, 200, {
      'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    })
  })
}
