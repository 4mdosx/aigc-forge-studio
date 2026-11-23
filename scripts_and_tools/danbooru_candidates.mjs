// 按 05 资产收集规范的采集矩阵，从 danbooru 拉候选池。
//
// 为什么用 danbooru 而不是 Pinterest：
//   Pinterest 只有「搜索词 → 图」，图里有什么全靠事后猜；danbooru 每条 post 自带结构化标签
//   （general / character / copyright / artist 分开），可以把采集矩阵的每个维度变成一个可过滤字段，
//   这正对应主线的「可解释性与控制力」。Pinterest 保留为补充（自产图 + 少量 reference）。
//
// 匿名限制：最多 2 个标签 + rating / order 修饰符。所以标签筛选全放客户端——
//   post 回来了，tag_string_* 全在手上，本地筛零成本。
//
// 用法：
//   node scripts_and_tools/danbooru_candidates.mjs --batch mecha-1123 --pages 6
//   node scripts_and_tools/danbooru_candidates.mjs --batch mecha-1123 --tags "power_armor" --pages 3

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')
const UA = 'aigc-forge-studio/0.1 (local dataset build)'
const API = 'https://danbooru.donmai.us'

// 欧美硬核科幻 IP 黑名单。教训：`power_armor + order:score` 拉回来的前 90 张里
// 有 ~55% 是战锤 40K / 银河战士 / DOOM —— 厚涂暗调装甲骑士，与「日系精细立绘」是两个物种。
// 根因是 danbooru 的 score 反映社区热度，而站点用户口味偏欧美。
const BANNED_COPYRIGHT = new Set([
  'metroid', 'warhammer_40k', 'doom', 'halo', 'star_wars', 'destiny', 'overwatch',
  'mass_effect', 'cyberpunk_2077', 'fallout', 'titanfall', 'starcraft', 'dead_space',
  'transformers', 'evangelion', 'gundam', 'macross', 'patlabor', 'ghost_in_the_shell',
])

// 日系赛璐璐着色信号：不是硬条件，用来给池子算「日系纯度」
const CEL_SIGNALS = new Set([
  'anime_coloring', 'cel_shading', 'flat_color', 'gradient', 'soft_shading',
  'looking_at_viewer', 'blush', 'ahoge', 'thighhighs', 'hair_ornament',
])

// 多人物同框 / 非单张立绘 / 非彩色成图 —— 05「单图硬条件」里可以直接判死的
const HARD_REJECT_TAGS = new Set([
  '2girls', '3girls', '4girls', '5girls', '6+girls', 'multiple_girls', 'multiple_boys',
  'comic', 'multiple_views', 'character_sheet', 'reference_sheet', 'model_sheet',
  'monochrome', 'greyscale', 'sketch', 'lineart', 'chibi', 'pixel_art',
  'english_text', 'speech_bubble', 'logo', 'watermark', 'signature', 'border',
  'lowres', 'bad_anatomy', 'bad_hands',
])

// 矩阵维度 → 标签映射。这些不是筛选条件，是打标用的结构信息。
const FLAG_RULES = {
  whiteBg: ['white_background', 'simple_background', 'transparent_background', 'grey_background'],
  crop: {
    full_body: ['full_body'],
    cowboy_shot: ['cowboy_shot'],
    upper_body: ['upper_body'],
    portrait: ['portrait', 'close-up', 'face_focus'],
  },
  view: {
    front: ['from_front', 'facing_viewer'],
    side: ['from_side', 'profile'],
    three_quarter: ['from_three_quarter', 'three-quarter_view'],
    back: ['from_behind', 'back'],
  },
  handInFrame: [
    'hand_on_hip', 'hands_up', 'hand_up', 'hand_on_own_chest', 'hand_to_mouth',
    'holding', 'holding_weapon', 'holding_sword', 'holding_gun', 'arm_up',
    'outstretched_arm', 'pointing', 'salute', 'peace_sign', 'clenched_hand',
  ],
  mecha: [
    'mecha_musume', 'mecha', 'armor', 'power_armor', 'mechanical_arm', 'mechanical_leg',
    'mechanical_parts', 'prosthesis', 'cyborg', 'exoskeleton', 'robot', 'android',
    'headgear', 'helmet', 'jetpack', 'thruster', 'cable', 'panel_lines',
  ],
}

function parseArgs(argv) {
  const out = { batch: '', pages: 4, tags: null, out: null, minLong: 1200, maxMB: 15, order: 'score' }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => argv[(i += 1)]
    if (a === '--batch') out.batch = next()
    else if (a === '--pages') out.pages = Number(next())
    else if (a === '--tags') out.tags = next().split('|').filter(Boolean)
    else if (a === '--order') out.order = next()
    else if (a === '--out') out.out = next()
    else if (a === '--min-long') out.minLong = Number(next())
    else if (a === '--max-mb') out.maxMB = Number(next())
    else if (a === '--help' || a === '-h') {
      console.log('node danbooru_candidates.mjs --batch <id> [--pages N] [--tags "a|b"] [--min-long 1200]')
      process.exit(0)
    } else throw new Error(`未知参数 ${a}`)
  }
  if (!out.batch) throw new Error('必须给 --batch')
  // 默认落自己的文件，绝不和 Pinterest 那批混写：两边 item 结构不同（Pinterest 没有 tags/flags）
  out.out ??= join(ROOT, 'data', 'capture', out.batch, 'candidates-danbooru.json')
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchJson(url, attempt = 0) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(40_000),
  })
  if (res.status === 429 || res.status === 503) {
    if (attempt >= 3) throw new Error(`限速未恢复 ${res.status}`)
    await sleep(3000 * (attempt + 1))
    return fetchJson(url, attempt + 1)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 120)}`)
  const body = await res.json()
  if (body && body.success === false) {
    throw new Error(`${body.error}: ${body.message}`)
  }
  return body
}

function tagsOf(post) {
  const split = (s) => (s ? s.trim().split(/\s+/).filter(Boolean) : [])
  return {
    general: split(post.tag_string_general),
    character: split(post.tag_string_character),
    copyright: split(post.tag_string_copyright),
    artist: split(post.tag_string_artist),
    meta: split(post.tag_string_meta),
  }
}

function buildFlags(tags) {
  const all = new Set([...tags.general, ...tags.meta])
  const has = (t) => all.has(t)
  const crop = Object.entries(FLAG_RULES.crop).find(([, list]) => list.some(has))?.[0] ?? null
  const view = Object.entries(FLAG_RULES.view).find(([, list]) => list.some(has))?.[0] ?? null
  return {
    whiteBg: FLAG_RULES.whiteBg.some(has),
    crop,
    view,
    handInFrame: FLAG_RULES.handInFrame.filter(has),
    mecha: FLAG_RULES.mecha.filter(has),
    solo: has('solo') || (has('1girl') && !has('multiple_girls')),
    celSignals: [...CEL_SIGNALS].filter(has).length,
  }
}

// 返回 { item } 或 { skip: reason }
function keep(post, query, opts) {
  const tags = tagsOf(post)
  const all = new Set([...tags.general, ...tags.meta])

  if (post.rating !== 'g') return { skip: 'rating' }
  for (const t of all) if (HARD_REJECT_TAGS.has(t)) return { skip: 'tag:' + t }
  if (!all.has('1girl')) return { skip: 'no-1girl' }
  if (all.has('multiple_girls') || all.has('6+girls')) return { skip: 'multi' }
  // 欧美科幻 IP 直接剔除：画风与「日系精细立绘」是两个物种
  for (const cp of tags.copyright) {
    if (BANNED_COPYRIGHT.has(cp)) return { skip: 'copyright:' + cp }
  }

  const w = Number(post.image_width) || 0
  const h = Number(post.image_height) || 0
  if (!w || !h) return { skip: 'no-size' }
  const long = Math.max(w, h)
  if (long < opts.minLong) return { skip: 'lowres' }
  const aspect = w / h
  if (aspect > 1.05) return { skip: 'landscape' }
  if (aspect < 0.3) return { skip: 'too-tall' }
  if (Number(post.file_size) > opts.maxMB * 1024 * 1024) return { skip: 'huge' }
  if (!post.file_url) return { skip: 'no-file' }

  const flags = buildFlags(tags)
  // 机娘题材必须真的有机械元素，否则就是普通动漫少女，会稀释整池的设计语言
  if (flags.mecha.length === 0) return { skip: 'no-mecha' }

  return {
    item: {
      id: post.id,
      score: post.score ?? 0,
      favCount: post.fav_count ?? 0,
      rating: post.rating,
      w,
      h,
      aspect: Number(aspect.toFixed(3)),
      fileUrl: post.file_url,
      sampleUrl: post.large_file_url ?? '',
      previewUrl: post.preview_file_url ?? '',
      md5: post.md5 ?? '',
      source: post.source ?? '',
      tags,
      flags,
      query,
    },
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const baseTags = args.tags ?? ['busou_shinki', 'frame_arms_girl', 'megami_device', 'infinite_stratos']
  const skipped = {}
  const items = []
  const seen = new Set()

  for (const base of baseTags) {
    const query = `${base} order:${args.order} rating:general`
    let pagesDone = 0
    for (let page = 1; page <= args.pages; page += 1) {
      const url = `${API}/posts.json?tags=${encodeURIComponent(query)}&limit=200&page=${page}`
      let posts
      try {
        posts = await fetchJson(url)
      } catch (e) {
        console.log(`  [FAIL] ${base} p${page}: ${e.message}`)
        break
      }
      if (!Array.isArray(posts) || posts.length === 0) break
      pagesDone += 1
      for (const post of posts) {
        const { item, skip } = keep(post, base, args)
        if (skip) {
          skipped[skip] = (skipped[skip] ?? 0) + 1
          continue
        }
        const key = item.md5 || String(item.id)
        if (seen.has(key)) {
          skipped.duplicate = (skipped.duplicate ?? 0) + 1
          continue
        }
        seen.add(key)
        items.push(item)
      }
      console.log(`  ${base} p${page}: ${posts.length} 条 → 累计通过 ${items.length}`)
      await sleep(1300) // 匿名 2 req/s，留余量
    }
    if (pagesDone === 0) console.log(`  [SKIP] ${base} 无结果`)
  }

  // 按 score 降序：高分图是画质的天然代理指标
  items.sort((a, b) => b.score - a.score)

  // 角色 / 版权分布 —— 决定「8 角色」怎么选，也用来发现 IP 集中风险
  const byCharacter = {}
  const byCopyright = {}
  for (const it of items) {
    const ch = it.tags.character[0] ?? '(unnamed)'
    byCharacter[ch] = (byCharacter[ch] ?? 0) + 1
    const cp = it.tags.copyright[0] ?? '(unknown)'
    byCopyright[cp] = (byCopyright[cp] ?? 0) + 1
  }
  const topBy = (o, n) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)

  let merged = items
  let prevTotal = 0
  if (existsSync(args.out)) {
    try {
      const prev = JSON.parse(readFileSync(args.out, 'utf8'))
      if (Array.isArray(prev.items)) {
        prevTotal = prev.items.length
        const have = new Set(items.map((it) => it.md5 || String(it.id)))
        merged = [...prev.items.filter((it) => !have.has(it.md5 || String(it.id))), ...items]
        merged.sort((a, b) => b.score - a.score)
      }
    } catch {
      // 旧文件坏了就覆盖
    }
  }

  const payload = {
    batch: args.batch,
    source: 'danbooru',
    generatedAt: new Date().toISOString(),
    baseTags,
    pages: args.pages,
    skipped,
    total: merged.length,
    byCharacter: topBy(byCharacter, 40),
    byCopyright: topBy(byCopyright, 40),
    items: merged,
  }
  mkdirSync(dirname(args.out), { recursive: true })
  writeFileSync(args.out, JSON.stringify(payload, null, 2))

  console.log(`\n本轮 ${items.length} 张，合并后 ${merged.length} 张（上轮 ${prevTotal}）→ ${args.out}`)
  console.log('淘汰统计:', skipped)
  console.log('\n角色 Top15:', topBy(byCharacter, 15).map(([k, v]) => `${k}:${v}`).join('  '))
  console.log('\n版权 Top10:', topBy(byCopyright, 10).map(([k, v]) => `${k}:${v}`).join('  '))
  const wb = merged.filter((i) => i.flags?.whiteBg).length
  const fb = merged.filter((i) => i.flags?.crop === 'full_body').length
  const hi = merged.filter((i) => i.flags?.handInFrame?.length > 0).length
  const cel = merged.filter((i) => (i.flags?.celSignals ?? 0) >= 3).length
  console.log(`\n矩阵覆盖: 白底 ${wb} / 全身 ${fb} / 手入画 ${hi} / 日系信号强 ${cel} / 共 ${merged.length}`)
}

main()
