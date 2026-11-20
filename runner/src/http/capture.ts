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
  assetTagCounts,
  assetsByIds,
  deleteAsset,
  ingestBytes,
  listAssetIds,
  pageAssets,
  groupAssets,
  nearestAssets,
  rejectAsset,
  replaceNobg,
  updateAsset,
  type AssetListQuery,
  type FinalVersion,
} from '../capture/asset.ts'
import { removeBackground } from '../capture/nobg.ts'
import {
  listCaptureJobs,
  resumeCaptureJobs,
  retryCaptureJob,
} from '../capture/jobs.ts'
import {
  enqueueDownload,
  enqueueNobg,
  listCaptureTasks,
  retryCaptureTask,
} from '../capture/tasks.ts'
import { pixivSessionFromFile } from '../chat/env.ts'
import { findRepoRoot } from '../config.ts'
import { RunnerError } from '../errors.ts'
import { relativePath } from '../path.ts'
import type { Runner } from '../task/queue.ts'
import { bytesOf, jsonObject, stringField } from './request.ts'

const execFile = promisify(execFileCb)

function nearestCountOf(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 10
  if (!/^[1-9]\d*$/.test(raw)) throw new RunnerError('k 必须是正整数')
  const count = Number(raw)
  if (!Number.isSafeInteger(count)) throw new RunnerError('k 必须是正整数')
  return count
}

function nearestOrderOf(raw: string | undefined): 'near' | 'far' {
  if (raw === undefined || raw === '' || raw === 'near') return 'near'
  if (raw === 'far') return 'far'
  throw new RunnerError('order 必须是 near 或 far')
}

const ASSET_STATUSES = new Set(['collected', 'processed', 'approved', 'rejected'])
const ASSET_RATINGS = new Set(['general', 'sensitive', 'questionable', 'explicit'])
const PAGE_SIZE_MAX = 200

function pageOffsetOf(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0
  if (!/^\d+$/.test(raw)) throw new RunnerError('offset 必须是非负整数')
  const offset = Number(raw)
  if (!Number.isSafeInteger(offset)) throw new RunnerError('offset 必须是非负整数')
  return offset
}

function pageSizeOf(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 60
  if (!/^[1-9]\d*$/.test(raw)) throw new RunnerError('size 必须是正整数')
  const size = Number(raw)
  if (!Number.isSafeInteger(size) || size > PAGE_SIZE_MAX) {
    throw new RunnerError(`size 必须是 1 到 ${PAGE_SIZE_MAX}`)
  }
  return size
}

function csvOf(raw: string | undefined, label: string, allowed?: Set<string>): string[] {
  if (raw === undefined || raw === '') return []
  const values = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  if (!allowed) return values
  for (const value of values) {
    if (!allowed.has(value)) throw new RunnerError(`${label} 无效: ${value}`)
  }
  return values
}

function assetListQueryOf(c: {
  req: {
    query: (name: string) => string | undefined
    queries: (name: string) => string[] | undefined
  }
}): AssetListQuery {
  const tags = [
    ...(c.req.queries('tag') ?? []),
    ...csvOf(c.req.query('tags'), 'tag'),
  ]
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '')
  const dataset = c.req.query('dataset')?.trim() ?? ''
  return {
    statuses: csvOf(c.req.query('status'), 'status', ASSET_STATUSES),
    ratings: csvOf(c.req.query('rating'), 'rating', ASSET_RATINGS),
    tags,
    safe: c.req.query('safe') === '1',
    datasetId: dataset === '' ? null : dataset,
  }
}

function hasAssetScope(query: AssetListQuery): boolean {
  return (
    query.statuses.length > 0 ||
    query.ratings.length > 0 ||
    query.tags.length > 0 ||
    query.safe ||
    query.datasetId !== null
  )
}

function nearestIdsOf(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw === '') return undefined
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '')
  if (ids.length === 0) throw new RunnerError('ids 不能为空')
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) throw new RunnerError(`ids 有重复: ${id}`)
    seen.add(id)
  }
  if (ids.length > 2000) throw new RunnerError('ids 过多')
  return ids
}

// 采集工作台：Pinterest / pixiv 链接 → 下载原图 → 异步预处理 → 手工整理素材池。
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

function isPinimgHost(host: string): boolean {
  return /(^|\.)pinimg\.com$/.test(host)
}

function isPinterestHost(host: string): boolean {
  return (
    /(^|\.)pinterest\.[a-z.]+$/.test(host) ||
    host === 'pin.it' ||
    host.endsWith('.pin.it')
  )
}

function isPximgHost(host: string): boolean {
  return /(^|\.)pximg\.net$/.test(host)
}

function isPixivHost(host: string): boolean {
  return /(^|\.)pixiv\.net$/.test(host)
}

function captureProviderOf(url: string): 'pinterest' | 'pixiv' {
  const host = new URL(url).hostname.toLowerCase()
  return isPixivHost(host) || isPximgHost(host) ? 'pixiv' : 'pinterest'
}

// 作品 id：/artworks/123、/en/artworks/123，或旧版 member_illust.php?illust_id=123
export function pixivArtworkIdOf(input: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return null
  }
  const fromPath = /\/artworks\/(\d+)/.exec(parsed.pathname)
  if (fromPath?.[1]) return fromPath[1]
  const illustId = parsed.searchParams.get('illust_id')
  if (illustId && /^\d+$/.test(illustId)) return illustId
  return null
}

// 链接归一：pinimg / pximg 直链 → image，作品页和 pin 页 → page。
// pixiv 作品页收成 https://www.pixiv.net/artworks/<id>，剥掉语言前缀和跟踪参数。
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
  const pinimg = isPinimgHost(host)
  const pin = isPinterestHost(host)
  const pximg = isPximgHost(host)
  const pixiv = isPixivHost(host)
  if (!pinimg && !pin && !pximg && !pixiv) {
    throw new RunnerError(
      '只支持 pinterest.com / pin.it / i.pinimg.com / pixiv.net / i.pximg.net 链接',
    )
  }
  if (pixiv) {
    const id = pixivArtworkIdOf(parsed.toString())
    if (!id) {
      throw new RunnerError('pixiv 只支持作品页（/artworks/ID）或图片直链')
    }
    return { kind: 'page', url: `https://www.pixiv.net/artworks/${id}` }
  }
  parsed.hash = ''
  parsed.search = ''
  return { kind: pinimg || pximg ? 'image' : 'page', url: parsed.toString() }
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
  const hit =
    /^https:\/\/i\.pinimg\.com\/[a-z0-9_]+\/([0-9a-f/]+\.[a-z0-9]+)$/i.exec(url)
  if (hit) return hit[1] ?? null
  const px =
    /i\.pximg\.net\/.+\/(\d+_p\d+)(?:_(?:master|square|custom)1200)?\.[a-z0-9]+$/i.exec(
      url,
    )
  return px ? (px[1] ?? null) : null
}

// 下载 referer：pximg 防盗链要求 pixiv 页面来源，其余默认 pinterest
export function refererFor(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return isPximgHost(host)
      ? 'https://www.pixiv.net/'
      : 'https://www.pinterest.com/'
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
  const hit = /^(https:\/\/i\.pinimg\.com\/)(\d+x\d*|originals)\/(.+)$/i.exec(
    url,
  )
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
  const hit = /^(https:\/\/i\.pinimg\.com\/)(\d+x\d*|originals)\/(.+)$/i.exec(
    url,
  )
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null
  const thumb = (parsed as Record<string, unknown>).thumbnail_url
  return typeof thumb === 'string' && thumb !== '' ? thumb : null
}

// master / square / custom 缩略图 → 原图候选。扩展名要探，原图常是 png 而缩略图是 jpg
export function pximgOriginalCandidates(url: string): string[] {
  const hit =
    /^https:\/\/i\.pximg\.net\/(?:c\/[^/]+\/)?(?:img-master|custom-thumb)\/img\/(\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d+_p\d+)_(?:master|square|custom)1200\.[a-z0-9]+$/i.exec(
      url,
    )
  const stem = hit?.[1]
  if (!stem) return []
  return ['jpg', 'png', 'gif'].map(
    (ext) => `https://i.pximg.net/img-original/img/${stem}.${ext}`,
  )
}

function urlsOriginal(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const urls = (value as Record<string, unknown>).urls
  if (!urls || typeof urls !== 'object' || Array.isArray(urls)) return null
  const original = (urls as Record<string, unknown>).original
  if (typeof original !== 'string' || original === '') return null
  if (!/i\.pximg\.net\/img-original\//i.test(original)) return null
  return original
}

// ajax /pages、作品详情，或页面里嵌的 img-original。社交卡片 og:image 不要
export function pixivImageUrlsOf(text: string, artworkId?: string): string[] {
  const fromJson = pixivJsonImageUrls(text)
  if (fromJson.length > 0) return fromJson
  if (artworkId) {
    const fromHtml = pixivHtmlOriginals(text, artworkId)
    if (fromHtml.length > 0) return fromHtml
  }
  const og = ogImageOf(text)
  if (og && /i\.pximg\.net\/(?:img-original|img-master)\//i.test(og))
    return [og]
  return []
}

function pixivJsonImageUrls(text: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const record = parsed as Record<string, unknown>
  if (record.error === true) return []
  const body = record.body
  if (Array.isArray(body)) {
    const urls: string[] = []
    for (const item of body) {
      const original = urlsOriginal(item)
      if (original) urls.push(original)
    }
    return urls
  }
  const direct = urlsOriginal(body)
  if (direct) return [direct]
  const illust = record.illust
  if (!illust || typeof illust !== 'object' || Array.isArray(illust)) return []
  const urls: string[] = []
  for (const item of Object.values(illust)) {
    const original = urlsOriginal(item)
    if (original) urls.push(original)
  }
  return urls
}

// 页面源码里的原图。pixiv 会把斜杠写成 \/ 或 \u002F
export function pixivHtmlOriginals(html: string, artworkId: string): string[] {
  const id = artworkId.replace(/[^\d]/g, '')
  if (id === '') return []
  const decoded = html.replace(/\\u002f/gi, '/').replace(/\\\//g, '/')
  const re = new RegExp(
    `https://i\\.pximg\\.net/img-original/[^"'\\s<>]*${id}_p(\\d+)\\.(jpg|jpeg|png|gif)`,
    'gi',
  )
  const found = new Map<number, string>()
  for (const match of decoded.matchAll(re)) {
    const index = Number(match[1])
    const url = match[0]
    if (!Number.isInteger(index) || !url || found.has(index)) continue
    found.set(index, url)
  }
  return [...found.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, url]) => url)
}

// R-18 等要登录的作品：/pages 是 error+空数组，详情里的 urls.original 是 null
export function pixivLoginRequired(text: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return false
  const record = parsed as Record<string, unknown>
  const body = record.body
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const urls = (body as Record<string, unknown>).urls
    if (urls && typeof urls === 'object' && !Array.isArray(urls)) {
      if ((urls as Record<string, unknown>).original === null) return true
    }
  }
  const message = typeof record.message === 'string' ? record.message : ''
  return (
    record.error === true &&
    message === '' &&
    Array.isArray(body) &&
    body.length === 0
  )
}

export function pixivAjaxMessageOf(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null
  const record = parsed as Record<string, unknown>
  if (record.error !== true) return null
  return typeof record.message === 'string' && record.message !== ''
    ? record.message
    : 'pixiv 拒绝了这次请求'
}

// oEmbed 明确报错（如 "Url was not found"）时提取错误文本，区分死 pin 与其他故障
export function oembedErrorOf(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null
  const error = (parsed as Record<string, unknown>).error
  return typeof error === 'string' && error !== '' ? error : null
}

// ---- 下载（curl 直连 → 代理回退） ----

function curlMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

async function curlRun(args: string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await execFile('curl', args, {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    })
    return outputText(stdout)
  } catch (err) {
    // --fail-with-body 下 HTTP 错误的响应体在 stdout，不能扔
    const stdout = outputText((err as { stdout?: unknown }).stdout)
    if (stdout !== '') return stdout
    throw err
  }
}

// 每次读取，改完 env.ts 不用重启。只认 PIXIV_PHPSESSID，不把文件里的其他密钥带出去。
function pixivCookie(): string | undefined {
  try {
    const root = findRepoRoot([import.meta.dirname])
    const path = join(root, 'env.ts')
    if (!existsSync(path)) return undefined
    const token = pixivSessionFromFile(readFileSync(path, 'utf8'))
    return token ? `PHPSESSID=${token}` : undefined
  } catch (err) {
    if (err instanceof RunnerError) throw err
    return undefined
  }
}

export function pixivRequestCookie(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (!isPixivHost(host) && !isPximgHost(host)) return undefined
  } catch {
    return undefined
  }
  return pixivCookie()
}

// 抓文本（pin 页 HTML / oEmbed JSON / pixiv ajax）。--fail-with-body 保留 4xx/5xx 响应体
async function fetchPage(
  url: string,
  referer?: string,
  cookie?: string,
): Promise<string> {
  const base = [
    '-sS',
    '-L',
    '--fail-with-body',
    '--compressed',
    '--max-filesize',
    '16777216',
    '-A',
    UA,
    ...(referer ? ['-e', referer] : []),
    ...(cookie ? ['-b', cookie] : []),
  ]
  const seconds = CURL_SECONDS
  const timeoutMs = (seconds + 10) * 1000
  let first = ''
  try {
    return await curlRun(
      [...base, '--max-time', String(seconds), url],
      timeoutMs,
    )
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
export async function downloadTo(
  url: string,
  dest: string,
  referer?: string,
  cookie?: string,
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
    ...(cookie ? ['-b', cookie] : []),
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
export function readMeta(
  dir: string,
  id: string,
): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(metaPathOf(dir, id), 'utf8'),
    )
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

// 页面/短链 → 图片 URL。Pinterest 用 og:image，失败再走 oEmbed。
// pixiv 作品页走 ajax /pages，一次拿齐每一页的 img-original。
export async function resolveMediaUrls(input: string): Promise<string[]> {
  const { kind, url } = normalizeCaptureUrl(input)
  const host = new URL(url).hostname.toLowerCase()
  if (kind === 'image') {
    return [isPximgHost(host) ? await upgradePximg(url) : url]
  }
  if (isPixivHost(host)) return resolvePixivPage(url)
  return [await resolvePinterestPage(url)]
}

async function resolveMediaUrl(input: string): Promise<string> {
  const urls = await resolveMediaUrls(input)
  const first = urls[0]
  if (!first) throw new RunnerError('无法解析出图片', 422)
  return first
}

async function resolvePinterestPage(url: string): Promise<string> {
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
    problems.push(
      oembedError ? `oEmbed：${oembedError}` : 'oEmbed 无 thumbnail_url',
    )
  } catch (err) {
    if (err instanceof RunnerError) throw err
    problems.push(`oEmbed 失败：${curlMessage(err)}`)
  }

  throw new RunnerError(
    `无法解析出图片（${problems.join('；')}）。链接可能已失效或需要登录`,
    422,
  )
}

function pixivLoginMessage(cookie: string | undefined): string {
  return cookie
    ? '登录态失效。重新登录 pixiv.net，把 Cookie 里的 PHPSESSID 更新到 env.ts 的 PIXIV_PHPSESSID'
    : '这个作品要登录才能看。打开已登录的 pixiv.net，从 Cookie 复制 PHPSESSID，写到仓库根目录 env.ts 的 PIXIV_PHPSESSID，保存后再采集'
}

async function resolvePixivPage(url: string): Promise<string[]> {
  const id = pixivArtworkIdOf(url)
  if (!id)
    throw new RunnerError('pixiv 只支持作品页（/artworks/ID）或图片直链', 422)
  const referer = `https://www.pixiv.net/artworks/${id}`
  const cookie = pixivCookie()
  const problems: string[] = []
  let loginWall = false
  try {
    const text = await fetchPage(
      `https://www.pixiv.net/ajax/illust/${id}/pages`,
      referer,
      cookie,
    )
    const urls = pixivImageUrlsOf(text, id)
    if (urls.length > 0) return urls
    if (pixivLoginRequired(text)) loginWall = true
    else problems.push(pixivAjaxMessageOf(text) ?? '作品接口没有原图地址')
  } catch (err) {
    problems.push(`作品接口失败：${curlMessage(err)}`)
  }
  try {
    const text = await fetchPage(
      `https://www.pixiv.net/ajax/illust/${id}`,
      referer,
      cookie,
    )
    const urls = pixivImageUrlsOf(text, id)
    if (urls.length > 0) return urls
    if (pixivLoginRequired(text)) loginWall = true
  } catch (err) {
    problems.push(`作品详情失败：${curlMessage(err)}`)
  }
  if (loginWall) throw new RunnerError(pixivLoginMessage(cookie), 422)
  try {
    const html = await fetchPage(referer, 'https://www.pixiv.net/', cookie)
    const urls = pixivImageUrlsOf(html, id)
    if (urls.length > 0) return urls
    problems.push('页面里没有原图地址')
  } catch (err) {
    problems.push(`页面抓取失败：${curlMessage(err)}`)
  }
  throw new RunnerError(
    `无法解析出图片（${problems.join('；')}）。作品可能已删除、设为私密，或需要登录`,
    422,
  )
}

// 缩略图直链升到同一页的 img-original。作品接口优先，失败再按扩展名试探
async function upgradePximg(url: string): Promise<string> {
  if (/\/img-original\//i.test(url)) return url
  const signature = imageSignatureOf(url)
  const id = /^(\d+)_p\d+$/.exec(signature ?? '')?.[1]
  if (id) {
    try {
      const pages = await resolvePixivPage(
        `https://www.pixiv.net/artworks/${id}`,
      )
      const match = signature
        ? pages.find((item) => imageSignatureOf(item) === signature)
        : undefined
      if (match) return match
    } catch {
      // 作品页拿不到时，按原图路径猜扩展名
    }
  }
  for (const candidate of pximgOriginalCandidates(url)) {
    if (await remoteImageExists(candidate)) return candidate
  }
  return url
}

async function remoteImageExists(url: string): Promise<boolean> {
  const cookie = pixivRequestCookie(url)
  const base = [
    '-sS',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '-I',
    '-L',
    '-A',
    UA,
    '-e',
    refererFor(url),
    ...(cookie ? ['-b', cookie] : []),
    '--max-time',
    '20',
  ]
  const statusOf = async (args: string[]): Promise<number> => {
    try {
      const text = await curlRun(args, 30_000)
      const code = Number(text.trim())
      return Number.isInteger(code) ? code : 0
    } catch {
      return 0
    }
  }
  const direct = await statusOf([...base, url])
  if (direct === 200 || direct === 206) return true
  if (direct === 404) return false
  const proxied = await statusOf([...base, '--proxy', PROXY, url])
  return proxied === 200 || proxied === 206
}

// 读尺寸；读不出来当超限处理（宁可重采样也不冒放大险）
async function overMaxEdge(file: string): Promise<boolean> {
  try {
    const { stdout } = await execFile('sips', [
      '-g',
      'pixelWidth',
      '-g',
      'pixelHeight',
      file,
    ])
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
      const candidates = [
        originalsOf(mediaUrl),
        withSizeSegment(mediaUrl, '1200x'),
      ]
      for (const candidate of candidates) {
        if (!candidate) continue
        try {
          await downloadTo(
            candidate,
            paths.rawAbs,
            'https://www.pinterest.com/',
          )
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
        ...((await overMaxEdge(paths.rawAbs)) ? ['-Z', String(MAX_EDGE)] : []),
        paths.rawAbs,
        '--out',
        paths.imageAbs,
      ],
      { timeout: 60_000 },
    )
    let width: number | null = null
    let height: number | null = null
    try {
      const { stdout } = await execFile('sips', [
        '-g',
        'pixelWidth',
        '-g',
        'pixelHeight',
        paths.imageAbs,
      ])
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

async function finalVersion(req: {
  text(): Promise<string>
}): Promise<FinalVersion> {
  const raw = await req.text()
  if (raw.trim() === '') return 'processed'
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new RunnerError('invalid JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RunnerError('body must be a JSON object')
  }
  const value = (body as { version?: unknown }).version
  if (value === undefined) return 'processed'
  if (value !== 'raw' && value !== 'processed' && value !== 'nobg') {
    throw new RunnerError('version 必须是 raw、processed 或 nobg')
  }
  return value
}

// ---- 端点 ----

export function mountCapture(app: Hono, runner: Runner): void {
  // Pinterest / pixiv 页面或短链 → 可下载的图片地址。前端匹配到对应站点后才调用。
  // pixiv 作品页返回每一页的原图，imgUrl 是第一页。
  app.post('/capture/resolve', async (c) => {
    const body = await jsonObject(c.req)
    const provider = stringField(body, 'provider')
    if (provider !== 'pinterest' && provider !== 'pixiv') {
      throw new RunnerError('provider 目前只支持 pinterest / pixiv')
    }
    const input = stringField(body, 'url')
    const normalized = normalizeCaptureUrl(input)
    if (captureProviderOf(normalized.url) !== provider) {
      throw new RunnerError(
        provider === 'pixiv' ? '这个链接不是 pixiv' : '这个链接不是 pinterest',
      )
    }
    const imgUrls = await resolveMediaUrls(input)
    const imgUrl = imgUrls[0]
    if (!imgUrl) throw new RunnerError('无法解析出图片', 422)
    return c.json({ imgUrl, imgUrls })
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
      await downloadTo(
        mediaUrl,
        tempAbs,
        refererFor(mediaUrl),
        pixivRequestCookie(mediaUrl),
      )
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
    return c.json({ ...asset, duplicate }, duplicate ? 200 : 201)
  })

  app.get('/capture/assets', (c) => {
    const query = assetListQueryOf(c)
    const view = c.req.query('view')
    if (view === 'ids') return c.json(listAssetIds(runner.db, query))
    if (view !== undefined && view !== '') throw new RunnerError('view 必须是 ids')
    return c.json(
      pageAssets(runner.db, {
        ...query,
        offset: pageOffsetOf(c.req.query('offset')),
        size: pageSizeOf(c.req.query('size')),
      }),
    )
  })

  app.get('/capture/assets/tags', (c) => {
    return c.json({ tags: assetTagCounts(runner.db, assetListQueryOf(c)) })
  })

  app.post('/capture/assets/lookup', async (c) => {
    const body = await jsonObject(c.req)
    if (
      !Array.isArray(body.ids) ||
      body.ids.some((id) => typeof id !== 'string' || id.trim() === '')
    ) {
      throw new RunnerError('ids 必须是图片 id 数组')
    }
    if (body.ids.length > PAGE_SIZE_MAX) throw new RunnerError('ids 过多')
    return c.json({ items: assetsByIds(runner.db, body.ids) })
  })

  app.get('/capture/assets/:id', (c) => {
    const asset = assetById(runner.db, c.req.param('id'))
    if (!asset) throw new RunnerError('image not found', 404)
    return c.json(asset)
  })

  app.get('/capture/assets/:id/nearest', async (c) => {
    const scope = assetListQueryOf(c)
    const ids = nearestIdsOf(c.req.query('ids'))
    return c.json(
      await nearestAssets(
        runner,
        c.req.param('id'),
        nearestCountOf(c.req.query('k')),
        nearestOrderOf(c.req.query('order')),
        ids ?? (hasAssetScope(scope) ? listAssetIds(runner.db, scope).ids : undefined),
      ),
    )
  })

  app.post('/capture/assets/groups', async (c) => {
    const body = await jsonObject(c.req)
    if (
      !Array.isArray(body.ids) ||
      body.ids.some((id) => typeof id !== 'string')
    ) {
      throw new RunnerError('ids 必须是图片 id 数组')
    }
    if (typeof body.groups !== 'number')
      throw new RunnerError('groups 必须是正整数')
    return c.json(await groupAssets(runner, body.ids, body.groups))
  })

  app.put('/capture/assets/:id', async (c) => {
    const body = await jsonObject(c.req)
    const patch: {
      sourceUrl?: string
      imgUrl?: string
      tags?: string[]
      embedding?: number[]
      rating?: string
      note?: string | null
    } = {}
    if (body.sourceUrl !== undefined) {
      if (typeof body.sourceUrl !== 'string')
        throw new RunnerError('sourceUrl 必须是字符串')
      patch.sourceUrl = body.sourceUrl
    }
    if (body.imgUrl !== undefined) {
      if (typeof body.imgUrl !== 'string')
        throw new RunnerError('imgUrl 必须是字符串')
      patch.imgUrl = body.imgUrl
    }
    if (body.tags !== undefined) {
      if (
        !Array.isArray(body.tags) ||
        body.tags.some((tag) => typeof tag !== 'string')
      ) {
        throw new RunnerError('tags 必须是 string[]')
      }
      patch.tags = body.tags
    }
    if (body.embedding !== undefined) {
      if (
        !Array.isArray(body.embedding) ||
        body.embedding.some((value) => typeof value !== 'number')
      ) {
        throw new RunnerError('embedding 必须是 number[]')
      }
      patch.embedding = body.embedding
    }
    if (body.rating !== undefined) {
      if (
        typeof body.rating !== 'string' ||
        !['general', 'sensitive', 'questionable', 'explicit'].includes(
          body.rating,
        )
      ) {
        throw new RunnerError(
          'rating 必须是 general、sensitive、questionable、explicit 之一',
        )
      }
      patch.rating = body.rating
    }
    if (body.note !== undefined) {
      if (body.note !== null && typeof body.note !== 'string')
        throw new RunnerError('note 必须是字符串')
      patch.note = body.note
    }
    return c.json(updateAsset(runner, c.req.param('id'), patch))
  })

  app.post('/capture/assets/:id/nobg', async (c) => {
    return c.json(await removeBackground(runner, c.req.param('id')))
  })

  app.put('/capture/assets/:id/nobg', async (c) => {
    const bytes = Buffer.from(await c.req.arrayBuffer())
    return c.json(replaceNobg(runner, c.req.param('id'), bytes))
  })

  app.post('/capture/assets/:id/approve', async (c) => {
    return c.json(
      await approveAsset(runner, c.req.param('id'), await finalVersion(c.req)),
    )
  })

  app.post('/capture/assets/:id/reject', (c) => {
    return c.json(rejectAsset(runner, c.req.param('id')))
  })

  app.delete('/capture/assets/:id', (c) => {
    deleteAsset(runner, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.get('/capture/jobs', (c) => {
    return c.json(listCaptureJobs(runner.db))
  })

  app.post('/capture/jobs/:id/retry', (c) => {
    return c.json(
      retryCaptureJob(runner.db, c.req.param('id'), runner.now().getTime()),
    )
  })

  // 采集页的前台队列：这里发起，GET /capture/tasks 查看。执行在 capture/tasks.ts。
  app.post('/capture/downloads', async (c) => {
    const body = await jsonObject(c.req)
    const raw = body.urls ?? (body.url === undefined ? undefined : [body.url])
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
      throw new RunnerError('urls 必须是字符串数组')
    }
    if (raw.length > 200) throw new RunnerError('urls 过多')
    const now = runner.now().getTime()
    let added = 0
    let duplicates = 0
    const tasks = []
    for (const value of raw) {
      const url = value.trim()
      if (url === '') continue
      const result = enqueueDownload(runner.db, { url }, now)
      if (result.duplicate) duplicates += 1
      else if (result.task) {
        tasks.push(result.task)
        added += 1
      }
    }
    return c.json({ tasks, added, duplicates })
  })

  app.post('/capture/cutouts', async (c) => {
    const body = await jsonObject(c.req)
    const ids = body.assetIds
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw new RunnerError('assetIds 必须是字符串数组')
    }
    if (ids.length > 200) throw new RunnerError('assetIds 过多')
    const now = runner.now().getTime()
    let added = 0
    let skipped = 0
    const tasks = []
    for (const id of ids) {
      const result = enqueueNobg(runner.db, id, now)
      if (result.skipped) skipped += 1
      else if (result.task) {
        tasks.push(result.task)
        added += 1
      }
    }
    return c.json({ tasks, added, skipped })
  })

  app.get('/capture/tasks', (c) => {
    return c.json(listCaptureTasks(runner.db))
  })

  app.post('/capture/tasks/:id/retry', (c) => {
    return c.json(
      retryCaptureTask(runner.db, c.req.param('id'), runner.now().getTime()),
    )
  })

  resumeCaptureJobs(runner.db, runner.now().getTime())

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
        const existing =
          typeof meta?.mediaUrl === 'string' ? meta.mediaUrl : null
        if (!existing) continue
        const same = signature
          ? imageSignatureOf(existing) === signature
          : existing === mediaUrl
        if (same) {
          return c.json(
            {
              duplicate: true,
              id: meta?.id ?? file.slice(0, -5),
              status: 'duplicate',
            },
            200,
          )
        }
      }
    }

    const id = captureId(runner.now())
    const rawAbs = join(dir, 'raw', `${id}${extOf(mediaUrl)}`)
    await downloadTo(
      mediaUrl,
      rawAbs,
      refererFor(mediaUrl),
      pixivRequestCookie(mediaUrl),
    )
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
    void processEntry(id, mediaUrl, {
      dir,
      rawAbs,
      imageAbs: join(dir, 'image', `${id}.jpg`),
    })
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
      const imageFile = existsSync(join(imageDir, `${id}.jpg`))
        ? `${id}.jpg`
        : null
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
      if (kind !== 'raw' && kind !== 'assets')
        throw new RunnerError('kind must be raw or assets')
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
