#!/usr/bin/env node
// 风格 LoRA caption 重写器。
//
// 为什么需要它：风格 LoRA 学的是「caption token ↔ 图像视觉特征」的绑定。
// 某个 token 出现在【所有】训练图的 caption 里 → 被绑到所有图的共性 = 风格/概念；
// 某个 token 只出现在【部分】图 → 被绑到那部分的个性 = 内容，稀释风格。
// 所以风格 caption 必须每张图【完全相同】= 触发词 + 一组固定风格词；
// WD14 那套随图变化的内容 tag（-maid / -cat_ears / -white_background）要全删。
//
// 用法：
//   node scripts_and_tools/rewrite_style_caption.mjs \
//     --dir data/training-export/<name>/img \
//     --trigger zxarmorstyle \
//     --style-tags "semi-realistic illustration, painterly rendering, dramatic cinematic lighting, polished black armor, ornate golden filigree, 1girl, solo" \
//     --tier T0 \
//     --dry-run
//
// 参数：
//   --dir          必需，training-export 的 img 目录
//   --trigger      必需，生造的罕见 token（风格锚点，推理时必须写）
//   --style-tags   恒定风格词，逗号分隔；每张图的 caption 都一样
//   --include-content  可选，保留每图原有 WD14 tag（已自动剥背景/角色名）。
//                      默认关闭——纯风格 LoRA 不要开，会把内容绑进 trigger。
//   --strip        可选，额外要剥的精确 tag，逗号分隔
//   --tier         可选，自动过滤档位 T0/T1/T2/T3，见 caption_tiers.mjs。
//                  T0 纯风格 / T1 设计语言 / T2 概念题材 / T3 角色身份。
//                  指定后原有 tag 按档位过滤；配 --include-content 用。
//   --no-backup    可选，改前不备份 .txt → .txt.bak（默认备份）
//   --dry-run      只预览不写盘

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { tierOf, loadCharacterNames, keepTag } from './caption_tiers.mjs'

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    trigger: { type: 'string' },
    'style-tags': { type: 'string', default: '' },
    'include-content': { type: 'boolean', default: false },
    strip: { type: 'string', default: '' },
    tier: { type: 'string', default: '' },
    'no-backup': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
})

if (!values.dir || !values.trigger) {
  console.error('需要 --dir <img 目录> 和 --trigger <触发词>')
  process.exit(1)
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const imgDir = resolve(repoRoot, values.dir)
if (!existsSync(imgDir)) {
  console.error(`目录不存在：${imgDir}`)
  process.exit(1)
}

const trigger = values.trigger.trim()
const stripExtra = new Set(
  values.strip.split(',').map((s) => s.trim()).filter(Boolean),
)
// 档位：指定后用 caption_tiers 的规则过滤；未指定走旧逻辑（仅剥背景/角色名/strip）
const tier = values.tier ? tierOf(values.tier.trim().toUpperCase()) : null
// 角色名 category=4（可选读，读不到就跳过，不阻塞）
const TAGGER_CSV = join(
  repoRoot, 'data', 'models', 'wd14', 'wd-eva02-large-tagger-v3', 'selected_tags.csv',
)
const CHAR_NAMES = loadCharacterNames(TAGGER_CSV)
if (tier) console.log(`档位：${tier.name}（${tier.desc}）`)

const styleTags = values['style-tags']
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

if (!styleTags.length && !values['include-content']) {
  console.error('需要 --style-tags <逗号分隔的风格词>，或开 --include-content')
  process.exit(1)
}

const txtFiles = readdirSync(imgDir)
  .filter((f) => f.endsWith('.txt') && !f.endsWith('.bak'))
  .sort()

if (!txtFiles.length) {
  console.error(`目录里没有 .txt：${imgDir}`)
  process.exit(1)
}

let changed = 0
for (const file of txtFiles) {
  let content = []
  if (values['include-content']) {
    const original = readFileSync(join(imgDir, file), 'utf8')
      .split(',').map((s) => s.trim()).filter(Boolean)
    // 剥触发词本身；其余按档位规则过滤
    const triggerLc = trigger.toLowerCase()
    content = original.filter((tag) => {
      if (tag.toLowerCase() === triggerLc) return false
      if (tier) return keepTag(tag, values.tier.trim().toUpperCase(), CHAR_NAMES, stripExtra)
      // 未指定档位：沿用内置 ALWAYS_DROP（背景/画质）+ 角色名 + strip
      return keepTag(tag, 'T3', CHAR_NAMES, stripExtra)
    })
  }
  // 恒定部分：触发词永远第一个（SDXL 对 token 位置敏感），后面跟固定风格词
  const caption = [trigger, ...styleTags, ...content].join(', ') + ','
  const path = join(imgDir, file)

  if (values['dry-run']) {
    console.log(`${file}  ${caption.slice(0, 160)}`)
    continue
  }
  if (!values['no-backup']) {
    const bak = `${path}.bak`
    if (!existsSync(bak)) copyFileSync(path, bak)
  }
  writeFileSync(path, `${caption}\n`)
  changed += 1
}

if (values['dry-run']) {
  console.log(`\n[dry-run] ${txtFiles.length} 个 caption 预览完毕，未写盘`)
} else {
  console.log(`已重写 ${changed} 个 caption（备份为 .txt.bak）`)
  console.log(`触发词：${trigger}｜恒定风格词 ${styleTags.length} 个｜include-content=${values['include-content']}`)
}
