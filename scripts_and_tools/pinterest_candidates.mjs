// 按 05 资产收集规范，从 Pinterest 拉「候选池」。
// 职责边界：只做「找到 + 硬条件过滤 + 记录来源」，不下载图片。
// 下载走 runner POST /capture/downloads（人工确认清单后执行），避免一次性灌进资产池。
//
// 用法：
//   node scripts_and_tools/pinterest_candidates.mjs --batch mecha-1123 --pages 2
//
// 关键约束（来自 05 规范「单图硬条件」）：
//   长边 ≥ 1200、竖幅/方图、非广告、非近重复
// 代理：Pinterest 直连不通，默认走 127.0.0.1:7897，可用 PIN_PROXY 覆盖。

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const PROXY = process.env.PIN_PROXY || 'http://127.0.0.1:7897'
const JAR = '/tmp/pin_candidates_cookies.txt'

// 关键词分三层：题材（保证机娘）/ 质感（保证日系精细立绘）/ 构图（保证立绘形态）
const DEFAULT_QUERIES = [
  // 题材层
  'mecha musume illustration',
  'mecha girl anime full body',
  'メカ娘 イラスト',
  'robot girl character design',
  // 质感层
  'anime character design full body illustration',
  '立ち絵 イラスト 女の子',
  // 构图层：白底/纯色底立绘，是主线的业务定义
  'anime girl full body white background',
  'mecha musume white background',
  // 结构层：机械部件显式出现，保证设计语言进池
  'anime girl mechanical arms illustration',
  'armored girl sci-fi illustration',
]

function parseArgs(argv) {
  const out = { batch: '', pages: 1, minLong: 1200, queries: null, out: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => argv[(i += 1)]
    if (a === '--batch') out.batch = next()
    else if (a === '--pages') out.pages = Number(next())
    else if (a === '--min-long') out.minLong = Number(next())
    else if (a === '--queries') out.queries = next().split('|').filter(Boolean)
    else if (a === '--out') out.out = next()
    else if (a === '--help' || a === '-h') {
      console.log('node pinterest_candidates.mjs --batch <id> [--pages N] [--min-long 1200] [--queries a|b|c] [--out path]')
      process.exit(0)
    } else throw new Error(`未知参数 ${a}`)
  }
  if (!out.batch) throw new Error('必须给 --batch')
  out.out ??= join(ROOT, 'data', 'capture', out.batch, 'candidates.json')
  return out
}

function curl(args, { raw = false } = {}) {
  const out = execFileSync(
    'curl',
    [
      '-s',
      '--max-time',
      '40',
      '-x',
      PROXY,
      '-A',
      UA,
      '-b',
      JAR,
      '-c',
      JAR,
      ...args,
    ],
    { encoding: raw ? 'buffer' : 'utf8', maxBuffer: 128 * 1024 * 1024 },
  )
  return out
}

// 搜索页只用来拿 csrftoken 与 appVersion —— 结果本身是客户端渲染，HTML 里没有图
function prime() {
  const html = curl([
    'https://www.pinterest.com/search/pins/?q=mecha',
    '-H',
    'Accept-Language: en-US,en;q=0.9',
  ])
  const m = html.match(/"appVersion":"([^"]+)"/)
  if (!m) throw new Error('拿不到 appVersion，可能被反爬拦截')
  return m[1]
}

function searchPage(query, appVersion, bookmark) {
  const options = {
    article: null,
    appliedProductFilters: '---',
    price_max: null,
    price_min: null,
    query,
    scope: 'pins',
    page_size: 25,
    bookmarks: bookmark ? [bookmark] : [],
    auto_correction_disabled: '',
    top_pin_id: '',
    filters: '',
    request_params: null,
    selected_one_bar_modules: null,
    source_id: null,
    top_pin_bounds: null,
    query_pin_sigs: null,
    customized_rerank_type: null,
  }
  const data = JSON.stringify({ options, context: {} })
  const url =
    'https://www.pinterest.com/resource/BaseSearchResource/get/?source_url=' +
    encodeURIComponent(`/search/pins/?q=${query}`) +
    '&data=' +
    encodeURIComponent(data)
  const body = curl([
    url,
    '-H',
    'Accept: application/json, text/javascript, */*, q=0.01',
    '-H',
    'X-APP-VERSION: ' + appVersion,
    '-H',
    'X-Pinterest-AppState: background',
    '-H',
    'X-Pinterest-PWS-Handler: www/search/[scope].js',
    '-H',
    'X-Requested-With: XMLHttpRequest',
    '-H',
    'Referer: ' + `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`,
  ])
  let json
  try {
    json = JSON.parse(body)
  } catch {
    throw new Error(`响应不是 JSON：${body.slice(0, 160)}`)
  }
  const rr = json.resource_response
  if (!rr || rr.status !== 'success') {
    throw new Error(`resource 失败：${rr?.message ?? body.slice(0, 160)}`)
  }
  return { results: rr.data?.results ?? [], bookmark: rr.bookmark ?? null }
}

function signOf(pin) {
  if (pin.image_signature) return pin.image_signature
  const url = pin.images?.orig?.url ?? ''
  const m = url.match(/\/([0-9a-f]{32,})\.(?:png|jpe?g|webp)/i)
  return m ? m[1] : url
}

function pick(pin, query, minLong) {
  const orig = pin.images?.orig
  if (!orig?.url) return { skip: 'no-orig' }
  const w = Number(orig.width) || 0
  const h = Number(orig.height) || 0
  if (!w || !h) return { skip: 'no-size' }
  const long = Math.max(w, h)
  if (long < minLong) return { skip: 'lowres' }
  const aspect = w / h
  // 只要竖幅到方图；横构图立绘在三成以内可以放宽，但第一批不收
  if (aspect > 1.05) return { skip: 'landscape' }
  if (aspect < 0.32) return { skip: 'too-tall' }
  if (pin.is_promoted) return { skip: 'promoted' }
  return {
    item: {
      id: pin.id,
      imgUrl: orig.url,
      w,
      h,
      aspect: Number(aspect.toFixed(3)),
      title: pin.title || pin.grid_title || '',
      alt: pin.seo_alt_text || '',
      domain: pin.domain || pin.link_domain || '',
      link: pin.link || '',
      pinner: pin.pinner?.username || '',
      board: pin.board?.name || '',
      signature: signOf(pin),
      query,
    },
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const queries = args.queries ?? DEFAULT_QUERIES
  const appVersion = prime()
  console.log(`appVersion=${appVersion}  proxy=${PROXY}  queries=${queries.length}  pages=${args.pages}`)

  const seen = new Set()
  const items = []
  const skipped = {}
  const perQuery = {}

  for (const query of queries) {
    let bookmark = null
    let got = 0
    for (let page = 0; page < args.pages; page += 1) {
      let res
      try {
        res = searchPage(query, appVersion, bookmark)
      } catch (e) {
        console.log(`  [FAIL] ${query} p${page + 1}: ${e.message}`)
        break
      }
      for (const pin of res.results) {
        if (pin.type !== 'pin') continue
        const { item, skip } = pick(pin, query, args.minLong)
        if (skip) {
          skipped[skip] = (skipped[skip] ?? 0) + 1
          continue
        }
        if (seen.has(item.signature)) {
          skipped.duplicate = (skipped.duplicate ?? 0) + 1
          continue
        }
        seen.add(item.signature)
        items.push(item)
        got += 1
      }
      if (!res.bookmark) break
      bookmark = res.bookmark
    }
    perQuery[query] = got
    console.log(`  ${String(got).padStart(3)}  ${query}`)
  }

  // 增量合并：同一批次多轮换关键词时累积，不覆盖上一轮的收获
  let merged = items
  let prevTotal = 0
  if (existsSync(args.out)) {
    try {
      const prev = JSON.parse(readFileSync(args.out, 'utf8'))
      if (Array.isArray(prev.items)) {
        prevTotal = prev.items.length
        const have = new Set(items.map((it) => it.signature))
        const kept = prev.items.filter((it) => !have.has(it.signature))
        merged = [...kept, ...items]
        for (const pq of prev.queries ?? []) {
          if (!queries.includes(pq)) queries.push(pq)
        }
      }
    } catch {
      // 旧文件坏了就覆盖，不阻塞
    }
  }

  const payload = {
    batch: args.batch,
    generatedAt: new Date().toISOString(),
    proxy: PROXY,
    minLong: args.minLong,
    queries,
    perQuery,
    skipped,
    total: merged.length,
    items: merged,
  }
  mkdirSync(dirname(args.out), { recursive: true })
  writeFileSync(args.out, JSON.stringify(payload, null, 2))
  console.log(`\n本轮新增 ${items.length} 张；合并后 ${merged.length} 张（上轮 ${prevTotal}）→ ${args.out}`)
  console.log('过滤统计:', skipped)
}

main()
