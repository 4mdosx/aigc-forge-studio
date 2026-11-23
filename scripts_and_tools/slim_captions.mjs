#!/usr/bin/env node
// slim_captions.mjs — 给 caption 瘦身，腾出 token 预算给风格段（2026-11-22）
//
// 背景：ohou 这批 19 张的 WD14 caption 最长 63 个 tag，粗估 82 token，已经超过
// CLIP 的 75 上限；再前置风格段只会把尾部 scene tag 全挤掉。瘦身两类词：
//
//   1) BASE —— AX4 不带 LoRA 也会画的基础项（人体、妆容、视线）。
//      这些词在 caption 里只是占位，浪费的是最宝贵的头部 token。
//   2) GENERIC —— 上位概念，当同一条里已有更具体的词时删除。
//      例：有 black_kimono 就删 kimono；有 black_gloves 就删 gloves。
//
// 不碰：服装细节、道具、场景、构图、配色、角色特征。那些才是要学的东西。
//
// 用法：
//   node scripts_and_tools/slim_captions.mjs --dir data/training-export/ohou/img --dry-run
//   node scripts_and_tools/slim_captions.mjs --dir ... --max-tags 40
//
// 幂等：已经是瘦身结果时再跑不会继续删（因为规则命中的词已不存在），
// 但 --max-tags 截断对超长条仍会生效。

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    'max-tags': { type: 'string', default: '0' },
    'dry-run': { type: 'boolean', default: false },
    'unify-colors': { type: 'boolean', default: false },
    drop: { type: 'string', default: '' },
    verbose: { type: 'boolean', default: false },
  },
})
if (!values.dir) {
  console.error('需要 --dir <caption 目录>')
  process.exit(1)
}
const maxTags = Number(values['max-tags'] || 0)

// AX4 自带，不需要在 caption 里教
// 例外：1girl / solo 是防多人的结构锚点，成本只有 2 token，保留。
const BASE = new Set([
  'breasts', 'large_breasts', 'huge_breasts', 'medium_breasts',
  'cleavage', 'underboob', 'thighs', 'thick_thighs', 'legs', 'bare_legs',
  'parted_lips', 'lips', 'makeup', 'looking_at_viewer', 'skindentation',
  'collarbone', 'shoulders', 'arms', 'hands', 'fingers', 'face',
  'detailed', 'highly_detailed', 'best_quality', 'absurdres',
])

// 上位 → 具体：若具体词存在，删上位
const GENERIC = {
  animal_ears: ['fox_ears', 'rabbit_ears', 'wolf_ears', 'cat_ears'],
  fake_animal_ears: ['rabbit_ears', 'fox_ears'],
  pantyhose: ['black_pantyhose', 'white_pantyhose', 'brown_pantyhose'],
  thighhighs: ['black_thighhighs', 'white_thighhighs'],
  gloves: ['black_gloves', 'white_gloves', 'half_gloves', 'fingerless_gloves'],
  kimono: ['black_kimono', 'white_kimono', 'fur-trimmed_kimono'],
  dress: ['black_dress', 'white_dress', 'short_kimono'],
  leotard: ['black_leotard', 'highleg_leotard', 'white_leotard'],
  highleg: ['highleg_leotard', 'highleg_panties'],
  footwear: ['black_footwear', 'white_footwear', 'high_heels'],
  long_hair: ['very_long_hair'],
  hair: ['long_hair', 'very_long_hair', 'short_hair'],
  // 元信息，没有视觉内容
  official_alternate_costume: [],
  official_art: [],
}

// 互斥组：同一条里只能留一个（按 WD14 原始顺序，即置信度最高的那个）。
// WD14 偶尔会给同一张图同时打 brown_hair 和 black_hair，这是 label noise，
// 留着会让模型把两个词绑到同一种发色上。
const EXCLUSIVE = [
  ['black_hair', 'brown_hair', 'red_hair', 'white_hair', 'blonde_hair', 'blue_hair',
   'pink_hair', 'purple_hair', 'grey_hair', 'silver_hair', 'green_hair', 'orange_hair'],
  ['black_pantyhose', 'brown_pantyhose', 'white_pantyhose'],
  ['black_thighhighs', 'white_thighhighs'],
  ['black_gloves', 'white_gloves', 'red_gloves'],
  ['black_kimono', 'white_kimono'],
  ['black_dress', 'white_dress', 'red_dress'],
  ['dark_skin', 'pale_skin', 'tan'],
]

const dir = resolve(values.dir)
const files = readdirSync(dir).filter((f) => f.endsWith('.txt'))
if (!files.length) throw new Error(`${dir} 里没有 .txt`)

let totalDropped = 0
let maxBefore = 0
let maxAfter = 0
let maxFile = ''

// --unify-colors：先扫全量，每个互斥组取出现最多的 tag 作为该组唯一代表。
// 19 张同角色时 WD14 会给出 brown_hair 2 / red_hair 1 / black_hair 18 这种分布，
// 少数派是识别噪声；统一到多数派才不会让模型把三种发色绑到同一个人身上。
const groupWinner = new Map()
if (values['unify-colors']) {
  for (const group of EXCLUSIVE) {
    const tally = new Map()
    for (const f of files) {
      const raw = readFileSync(join(dir, f), 'utf8').replace(/,\s*$/, '')
      for (const t of raw.split(',').map((s) => s.trim())) {
        if (group.includes(t)) tally.set(t, (tally.get(t) || 0) + 1)
      }
    }
    let best = null
    let bestN = 0
    for (const [t, n] of tally) if (n > bestN) { best = t; bestN = n }
    if (best) groupWinner.set(group, best)
  }
  for (const [g, w] of groupWinner) console.log(`  统一 ${g.slice(0, 3).join('/')}… → ${w}`)
}

for (const f of files) {
  const p = join(dir, f)
  const raw = readFileSync(p, 'utf8').trim()
  const parts = raw
    .replace(/,\s*$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  // 触发词/标记位与风格段（含空格的词组）一律保留，不参与规则
  const keep = []
  const body = []
  for (const t of parts) {
    if (t.includes(' ') || t.startsWith('@') || t === values.trigger) keep.push(t)
    else body.push(t)
  }

  const set = new Set(body)
  const extraDrop = new Set(
    (values.drop || '').split(',').map((s) => s.trim()).filter(Boolean),
  )
  const dropped = []
  const kept = []
  for (const t of body) {
    if (BASE.has(t) || extraDrop.has(t)) { dropped.push(t); continue }
    const supersededBy = GENERIC[t]
    if (supersededBy === undefined) {
      // 不在 GENERIC 表里 → 保留（绝大多数 tag 走这里）
      kept.push(t)
      continue
    }
    if (supersededBy.length === 0) { dropped.push(t); continue }
    if (supersededBy.some((s) => set.has(s) && s !== t)) { dropped.push(t); continue }
    kept.push(t)
  }

  // 互斥组：每组只留一个。默认留 WD14 置信度最高的（最先出现），
  // --unify-colors 时留全量里的多数派。
  for (const group of EXCLUSIVE) {
    const hit = kept.filter((t) => group.includes(t))
    if (!hit.length) continue
    const idx = kept.indexOf(hit[0])
    const win = (values['unify-colors'] && groupWinner.get(group)) || hit[0]
    for (const t of hit) {
      const at = kept.indexOf(t)
      if (at < 0) continue
      if (t !== win) dropped.push(t)
      kept.splice(at, 1)
    }
    kept.splice(idx, 0, win)
  }

  let out = [...keep, ...kept]
  if (maxTags > 0 && out.length > maxTags) out = out.slice(0, maxTags)

  maxBefore = Math.max(maxBefore, parts.length)
  maxAfter = Math.max(maxAfter, out.length)
  if (out.length >= maxAfter && maxAfter === out.length) {
    const est = Math.round(out.length * 1.3)
    if (est >= Math.round(maxAfter * 1.3)) maxFile = f
  }
  totalDropped += dropped.length
  if (values.verbose && dropped.length) console.log(`  ${f}: -${dropped.length} → ${dropped.join(', ')}`)
  if (!values['dry-run']) writeFileSync(p, `${out.join(', ')},`)
}

const estMax = Math.round(maxAfter * 1.3)
console.log(`${values['dry-run'] ? '[dry] ' : ''}处理 ${files.length} 个 caption`)
console.log(`最多 tag 数：${maxBefore} → ${maxAfter}（粗估 ${estMax} token）${estMax > 75 ? '  ⚠ 仍超 75' : ''}`)
console.log(`共删除 ${totalDropped} 个 tag（平均 ${(totalDropped / files.length).toFixed(1)}/条）`)
