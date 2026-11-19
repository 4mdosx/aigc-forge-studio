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

import {
  approveAsset,
  assetById,
  ingestBytes,
  listAssets,
  processAsset,
  rejectAsset,
  resumeCollected,
  updateAsset,
} from '../capture/asset.ts'
import { RunnerError } from '../errors.ts'
import { relativePath } from '../path.ts'
import type { Runner } from '../task/queue.ts'
import { bytesOf, jsonObject, stringField } from './request.ts'

const execFile = promisify(execFileCb)

// 采集工作台：Pinterest 链接 → 下载原图 → 异步预处理 → 手工整理素材池。
// 目录即真相源（不进 SQLite，不再按 folder 分）：
//   data/capture/raw/<id>.<ext>     原图（尽量提升到 i.pinimg originals 分辨率）
//   data/capture/image/<id>.jpg     预处理产物（jpeg q88，长边 ≤3072）
//   data/capture/image/<id>.json    sidecar meta（source/status/尺寸/record）
// 条目 id 形如 20261116-185112-a1b2，删除/整理不设端点——手工在文件系统做。

const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const KINDS = ['raw', 'image', 'assets'] as const
const HASH_RE = /^[a-f0-9]{64}$/
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

// pinimg 图片签名：尺寸段之后的完整尾段（c4/02/68/<hash32>.jpg），同一张图所有尺寸变体共享；
// pximg（pixiv）签名 = 作品号+页号（12345_p0），原图/master/square 变体共享；其他返回 null
export function imageSignatureOf(url: string): string | null {
  const hit = /^https:\/\/i\.pinimg\.com\/[a-z0-9_]+\/([0-9a-f/]+\.[a-z0-9]+)$/i.exec(url)
  if (hit) return hit[1] ?? null
  const px = /i\.pximg\.net\/.+\/(\d+_p\d+)(?:_master1200|_square1200)?\.[a-z0-9]+$/i.exec(url)
  return px ? (px[1] ?? null) : null
}

// 下载 referer：pximg 防盗链要求 pixiv 页面来源，其余默认 pinterest
export function refererFor(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return /(^|\.)pximg\.net$/.test(host) ? 'https://www.pixiv.net/' : 'https://www.pinterest.com/'
  } catch {
    return 'https://www.pinterest.com/'
  }
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

// 当前尺寸段（'736x' | '1200x' | 'originals' | null）
export function sizeSegmentOf(url: string): string | null {
  const hit = /^https:\/\/i\.pinimg\.com\/(\d+x\d*|originals)\//i.exec(url)
  return hit ? (hit[1] ?? '').toLowerCase() : null
}

// 替换尺寸段；目标段与当前相同或非 pinimg 返回 null
export function withSizeSegment(url: string, segment: string): string | null {
  const hit = /^(https:\/\/i\.pinimg\.com\/)(\d+x\d*|originals)\/(.+)$/i.exec(url)
  if (!hit) return null
  if ((hit[2] ?? '').toLowerCase() === segment.toLowerCase()) return null
  return `${hit[1]}${segment}/${hit[3]}`
}

export function extOf(url: string): string {
  const hit = /\.(jpe?g|png|gif|webp|bmp)(?:[?#].*)?$/i.exec(url)
  return hit ? `.${(hit[1] ?? 'jpg').toLowerCase()}` : '.jpg'
}

const IMAGE_EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
}

// 本地上传：优先看文件名后缀，没有后缀时看 MIME。jpeg 统一成 .jpg。
export function imageExtOf(name: string, type: string): string | null {
  const fromName = /\.(jpe?g|png|gif|webp|bmp)$/i.exec(name)
  if (fromName) {
    const ext = `.${(fromName[1] ?? 'jpg').toLowerCase()}`
    return ext === '.jpeg' ? '.jpg' : ext
  }
  return IMAGE_EXT_BY_TYPE[type.toLowerCase()] ?? null
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

function ensureEntryDirs(dir: string): void {
  mkdirSync(join(dir, 'raw'), { recursive: true })
  mkdirSync(join(dir, 'image'), { recursive: true })
}

function metaPathOf(dir: string, id: string): string {
  return join(dir, 'image', `${id}.json`)
}

// meta 读写导出给 tag.ts 复用（同一 sidecar 格式，一处真相）
export function readMeta(dir: string, id: string): Record<string, unknown> | null {
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

export function writeMeta(
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

// 异步预处理：尺寸段阶梯提升（originals → 1200x）→ sips 转 jpeg（只缩不放）→ 尺寸 → meta 收尾
async function processEntry(
  id: string,
  mediaUrl: string,
  paths: { dir: string; rawAbs: string; imageAbs: string },
): Promise<void> {
  inflight.add(id)
  try {
    // 采集目录在预处理期间被删：老路径不存在就放弃，避免 mkdirSync 造出幽灵目录
    if (!existsSync(paths.dir)) return
    const meta = readMeta(paths.dir, id) ?? { id, status: 'processing' }
    const remote = /^https?:\/\//i.test(mediaUrl)
    let record = remote ? (sizeSegmentOf(mediaUrl) ?? 'og') : 'upload'

    // 阶梯提升：originals 优先，失败退 1200x（og:image 常给 736x 甚至 236x）
    const current = sizeSegmentOf(mediaUrl)
    if (remote && current !== 'originals') {
      const candidates = [originalsOf(mediaUrl), withSizeSegment(mediaUrl, '1200x')]
      for (const candidate of candidates) {
        if (!candidate) continue
        try {
          await downloadTo(candidate, paths.rawAbs, 'https://www.pinterest.com/')
          mediaUrl = candidate
          record = sizeSegmentOf(candidate) ?? record
          break
        } catch {
          // 该段不存在（403/404 常见），继续退下一档
        }
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
    const meta = readMeta(paths.dir, id) ?? { id }
    writeMeta(paths.dir, id, {
      ...meta,
      status: 'failed',
      error: curlMessage(err),
    })
  } finally {
    inflight.delete(id)
  }
}

// ---- 端点 ----

export function mountCapture(app: Hono, runner: Runner): void {
  // Pinterest 页面或短链 → 可下载的图片地址。前端匹配到 Pinterest 后才调用。
  app.post('/capture/resolve', async (c) => {
    const body = await jsonObject(c.req)
    const provider = stringField(body, 'provider')
    if (provider !== 'pinterest') throw new RunnerError('provider 目前只支持 pinterest')
    const imgUrl = await resolveMediaUrl(stringField(body, 'url'))
    return c.json({ imgUrl })
  })

  // 下载或接收本地图片：先落到 temp，算出 hash 后移入 capture/raw/<hash>/。立即返回，预处理异步。
  app.post('/capture/collected', async (c) => {
    const type = c.req.header('content-type') ?? ''
    let bytes: Buffer
    let ext: string | null
    let sourceType: 'manual' | 'crawler' = 'manual'
    let sourceUrl = ''
    let imgUrl = ''
    if (type.includes('multipart/form-data')) {
      const body = await c.req.parseBody()
      const file = body.file
      if (!(file instanceof File)) throw new RunnerError('file is required')
      ext = imageExtOf(file.name, file.type)
      bytes = Buffer.from(await file.arrayBuffer())
    } else {
      const body = await jsonObject(c.req)
      if (body.sourceType !== undefined) {
        if (body.sourceType !== 'manual' && body.sourceType !== 'crawler') {
          throw new RunnerError('sourceType 必须是 manual 或 crawler')
        }
        sourceType = body.sourceType
      }
      sourceUrl = typeof body.sourceUrl === 'string' ? body.sourceUrl : ''
      imgUrl = typeof body.imgUrl === 'string' ? body.imgUrl : ''
      if (imgUrl.trim() === '') throw new RunnerError('imgUrl is required')
      const mediaUrl = normalizeMediaUrl(imgUrl)
      ext = extOf(mediaUrl)
      const tempDir = join(runner.dataDir, 'capture', 'temp')
      mkdirSync(tempDir, { recursive: true })
      const tempAbs = join(tempDir, `${captureId(runner.now())}${ext}`)
      await downloadTo(mediaUrl, tempAbs, refererFor(mediaUrl))
      bytes = readFileSync(tempAbs)
      rmSync(tempAbs, { force: true })
      imgUrl = mediaUrl
    }
    if (!ext) throw new RunnerError('只接受 jpg、png、gif、webp、bmp')
    const { asset, duplicate } = await ingestBytes(runner, bytes, ext, {
      type: sourceType,
      sourceUrl,
      imgUrl,
    })
    if (!duplicate || asset.status === 'collected') void processAsset(runner, asset.id)
    return c.json({ ...asset, duplicate }, duplicate ? 200 : 201)
  })

  app.get('/capture/assets', (c) => {
    const items = listAssets(runner.db)
    return c.json({ total: items.length, items })
  })

  app.get('/capture/assets/:id', (c) => {
    const asset = assetById(runner.db, c.req.param('id'))
    if (!asset) throw new RunnerError('image not found', 404)
    return c.json(asset)
  })

  app.put('/capture/assets/:id', async (c) => {
    const body = await jsonObject(c.req)
    const patch: {
      sourceUrl?: string
      imgUrl?: string
      tags?: string[]
      embedding?: number[]
      note?: string | null
    } = {}
    if (body.sourceUrl !== undefined) {
      if (typeof body.sourceUrl !== 'string') throw new RunnerError('sourceUrl 必须是字符串')
      patch.sourceUrl = body.sourceUrl
    }
    if (body.imgUrl !== undefined) {
      if (typeof body.imgUrl !== 'string') throw new RunnerError('imgUrl 必须是字符串')
      patch.imgUrl = body.imgUrl
    }
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string')) {
        throw new RunnerError('tags 必须是 string[]')
      }
      patch.tags = body.tags
    }
    if (body.embedding !== undefined) {
      if (!Array.isArray(body.embedding) || body.embedding.some((value) => typeof value !== 'number')) {
        throw new RunnerError('embedding 必须是 number[]')
      }
      patch.embedding = body.embedding
    }
    if (body.note !== undefined) {
      if (body.note !== null && typeof body.note !== 'string') throw new RunnerError('note 必须是字符串')
      patch.note = body.note
    }
    return c.json(updateAsset(runner, c.req.param('id'), patch))
  })

  app.post('/capture/assets/:id/approve', (c) => {
    return c.json(approveAsset(runner, c.req.param('id')))
  })

  app.post('/capture/assets/:id/reject', (c) => {
    return c.json(rejectAsset(runner, c.req.param('id')))
  })

  resumeCollected(runner)

  // 提交 Pinterest 链接：同步完成 og:image 保底下载（原图落到 capture/raw），预处理异步
  app.post('/capture/pins', async (c) => {
    const body = await jsonObject(c.req)
    const url = stringField(body, 'url')
    const dir = captureRoot(runner.dataDir)
    ensureEntryDirs(dir)

    const mediaUrl =
      typeof body.mediaUrl === 'string' && body.mediaUrl !== ''
        ? normalizeMediaUrl(body.mediaUrl)
        : await resolveMediaUrl(url)

    // 查重：pinimg 图按 signature（尺寸变体共享尾段 hash），其他图按完整 URL。
    // 重复直接跳过，不下载不入库
    const signature = imageSignatureOf(mediaUrl)
    const imageDir = join(dir, 'image')
    if (existsSync(imageDir)) {
      for (const file of readdirSync(imageDir)) {
        if (!file.endsWith('.json')) continue
        const meta = readMeta(dir, file.slice(0, -5))
        const existing = typeof meta?.mediaUrl === 'string' ? meta.mediaUrl : null
        if (!existing) continue
        const same = signature
          ? imageSignatureOf(existing) === signature
          : existing === mediaUrl
        if (same) {
          return c.json(
            { duplicate: true, id: meta?.id ?? file.slice(0, -5), status: 'duplicate' },
            200,
          )
        }
      }
    }

    const id = captureId(runner.now())
    const rawAbs = join(dir, 'raw', `${id}${extOf(mediaUrl)}`)
    await downloadTo(mediaUrl, rawAbs, refererFor(mediaUrl))
    if (statSync(rawAbs).size < MIN_IMAGE_BYTES) {
      rmSync(rawAbs, { force: true })
      throw new RunnerError('下载的内容不是有效图片', 502)
    }
    writeMeta(dir, id, {
      id,
      source: url,
      mediaUrl,
      status: 'processing',
      record: /\/originals\//i.test(mediaUrl) ? 'originals' : 'og',
      createdAt: runner.now().toISOString(),
    })
    void processEntry(id, mediaUrl, { dir, rawAbs, imageAbs: join(dir, 'image', `${id}.jpg`) })
    return c.json({ id, status: 'processing' }, 201)
  })

  // 本地图片：multipart file，落到 capture/raw 后走同一套预处理
  app.post('/capture/files', async (c) => {
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) throw new RunnerError('file is required')
    const dir = captureRoot(runner.dataDir)
    ensureEntryDirs(dir)
    const ext = imageExtOf(file.name, file.type)
    if (!ext) throw new RunnerError('只接受 jpg、png、gif、webp、bmp')
    const bytes = Buffer.from(await file.arrayBuffer())
    if (bytes.length < MIN_IMAGE_BYTES) {
      throw new RunnerError('文件太小，不是有效图片')
    }
    const id = captureId(runner.now())
    const rawAbs = join(dir, 'raw', `${id}${ext}`)
    writeFileSync(rawAbs, bytes)
    writeMeta(dir, id, {
      id,
      source: file.name || 'upload',
      status: 'processing',
      record: 'upload',
      createdAt: runner.now().toISOString(),
    })
    void processEntry(id, '', {
      dir,
      rawAbs,
      imageAbs: join(dir, 'image', `${id}.jpg`),
    })
    return c.json({ id, status: 'processing' }, 201)
  })

  // 条目列表（状态从 sidecar meta 推断；重启中断的 processing 标为 failed）
  app.get('/capture/items', (c) => {
    const dir = captureRoot(runner.dataDir)
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
      if (status === 'processing' && !inflight.has(id)) {
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
        rawUrl: rawFile ? `/capture/file/raw/${rawFile}` : null,
        imageUrl: imageFile ? `/capture/file/image/${imageFile}` : null,
        tagCount: Array.isArray(meta.tags) ? meta.tags.length : null,
        tagError: typeof meta.tagError === 'string' ? meta.tagError : null,
      })
    }
    items.sort((a, b) => String(b.id).localeCompare(String(a.id)))
    return c.json({ total: items.length, items })
  })

  // 图片服务：/capture/file/<raw|image>/<filename>
  // 以及 /capture/file/<raw|assets>/<hash>/<filename>
  app.get('/capture/file/*', (c) => {
    const path = relativePath(c.req.path.slice('/capture/file/'.length))
    const parts = path.split('/')
    let abs: string
    let filename: string
    if (parts.length === 3) {
      const [kind, hash, name] = parts as [string, string, string]
      if (kind !== 'raw' && kind !== 'assets') throw new RunnerError('kind must be raw or assets')
      if (!HASH_RE.test(hash)) throw new RunnerError('invalid hash')
      filename = name
      abs = join(captureRoot(runner.dataDir), kind, hash, name)
    } else if (parts.length === 2) {
      const [kind, name] = parts as [string, string]
      if (!(KINDS as readonly string[]).includes(kind)) {
        throw new RunnerError('kind must be raw or image')
      }
      filename = name
      abs = join(captureRoot(runner.dataDir), kind, name)
    } else {
      throw new RunnerError('invalid capture file path')
    }
    if (!FILENAME_RE.test(filename) || filename.includes('..')) {
      throw new RunnerError('invalid filename')
    }
    const dot = filename.lastIndexOf('.')
    if (dot <= 0) throw new RunnerError('invalid filename')
    const ext = filename.slice(dot).toLowerCase()
    if (!existsSync(abs)) throw new RunnerError('file not found', 404)
    return c.body(bytesOf(readFileSync(abs)) as ArrayBuffer, 200, {
      'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    })
  })
}
