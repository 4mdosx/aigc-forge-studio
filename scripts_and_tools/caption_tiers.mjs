// caption 自动过滤分档。
// 按「训练目的」决定 WD14 tag 的保留粒度；rewrite_style_caption.mjs 引用本文件。
//
// 四档对应四种目的：
//   T0 pure-style    纯风格   —— 内容可杂，只锁画法。删光所有内容 tag。
//   T1 design        设计语言 —— 锁黑金/厚重机械等设计特征，删掉题材/角色/背景。
//   T2 concept       概念题材 —— 连"舰娘"题材一起锁，删角色个体/背景。
//   T3 identity      角色身份 —— 锁某角色，保留身份 tag，删背景/无关内容。
//   knob             属性旋钮 —— 按图用 --include-content 做开关，不属于过滤档。

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// 这些词无论哪档都删：绑进 LoRA 会把背景/画质锁死
export const ALWAYS_DROP = new Set([
  'white_background', 'black_background', 'gray_background', 'grey_background',
  'simple_background', 'solid_color_background', 'solid_background',
  'transparent_background', 'plain_background', 'gradient_background',
  'colored_background', 'black_border', 'border',
  // 画质/水印噪声，训练无意义
  'lowres', 'worst_quality', 'low_quality', 'blurry', 'watermark',
  'signature', 'username', 'artist_name', 'text', 'error',
])

// 各档的「额外删除」规则。命中即删。
// background family 由 ALWAYS_DROP 覆盖；这里补各档特有的。
export const TIERS = {
  'T0': {
    name: '纯风格',
    desc: '只留触发词 + 恒定风格词，WD14 tag 全删',
    dropAll: true,
  },
  'T1': {
    name: '设计语言',
    desc: '删题材/主体个体/角色名，保留设计特征（靠 --style-tags 给）',
    dropAll: true, // 设计特征由恒定 style-tags 提供，其余全删
  },
  'T2': {
    name: '概念题材',
    desc: '删角色名/个体/背景，题材词由恒定 style-tags 给',
    dropAll: true,
  },
  'T3': {
    name: '角色身份',
    desc: '保留身份 tag，仅删背景/画质/角色名以外的噪声',
    dropAll: false,
    // 角色 LoRA 里保留：发色瞳色服装身份类 tag；删掉姿势/构图/背景
    dropPrefixes: ['sitting', 'standing', 'looking_at', 'from_', 'cowboy_shot', 'full_body', 'upper_body', 'close-up'],
  },
}

export function tierOf(name) {
  const t = TIERS[name]
  if (!t) throw new Error(`未知档位 ${name}，可选：${Object.keys(TIERS).join(', ')}`)
  return t
}

// 从 WD14 selected_tags.csv 读 category=4（角色名）。所有档都剥——
// 角色名会把具体人物绑进触发词，除非你在训角色 LoRA（那是 T3，用触发词而非 tag 指定）。
export function loadCharacterNames(csvPath) {
  const names = new Set()
  if (!existsSync(csvPath)) return names
  for (const line of readFileSync(csvPath, 'utf8').trim().split('\n').slice(1)) {
    const parts = line.split(',')
    if (parts[2] === '4') names.add(parts[1].trim())
  }
  return names
}

// 判断单个 tag 在某档下是否保留。保留 true，删除 false。
export function keepTag(tag, tierName, charNames, extraStrip = new Set()) {
  const lc = tag.toLowerCase()
  if (ALWAYS_DROP.has(lc)) return false
  if (charNames.has(tag)) return false
  if (extraStrip.has(tag)) return false
  const tier = tierOf(tierName)
  if (tier.dropAll) return false
  if (tier.dropPrefixes?.some((p) => lc.startsWith(p))) return false
  return true
}
