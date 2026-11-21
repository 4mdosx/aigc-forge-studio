// caption 自动过滤分档 —— 辅助验证脚本用。
// 真相源在 runner/src/train/captionTiers.ts；本文件必须与之行为一致，改那边记得同步这里。
// rewrite_style_caption.mjs 引用本文件，做本地 dry-run 验证。
//
// 四档对应四种目的：
//   T0 pure-style    纯风格   —— 内容可杂，只锁画法。WD14 tag 全删。
//   T1 design        设计语言 —— 只留设计/材质/结构 tag（装甲、金属、机械）。
//   T2 concept       概念题材 —— 留题材/服装/物体，删身份细节/姿势/背景。
//   T3 identity      角色身份 —— 留身份/发色/瞳色/服装，删姿势/背景/角色名。
//   knob             属性旋钮 —— 按图用 --include-content 做开关，不属于过滤档。

import { readFileSync, existsSync } from 'node:fs'

export const ALWAYS_DROP = new Set([
  'white_background', 'black_background', 'gray_background', 'grey_background',
  'simple_background', 'solid_color_background', 'solid_background',
  'transparent_background', 'plain_background', 'gradient_background',
  'colored_background', 'black_border', 'border',
  'lowres', 'worst_quality', 'low_quality', 'blurry', 'watermark',
  'signature', 'username', 'artist_name', 'text', 'error',
])

const POSE_PREFIXES = [
  'sitting', 'standing', 'looking_at', 'looking_to', 'from_', 'cowboy_shot',
  'full_body', 'upper_body', 'close-up', 'close_up', 'portrait', 'arms_',
  'arm_up', 'crossed_legs', 'lying', 'kneeling', 'one_eye_closed',
]

const IDENTITY_HINT = /(?:^|_)(eyes?|hair|iris|pupils?|expression|smile|blush|mouth|ears?|tail|horns?|skin|breasts?|ass|thighs?|clavicle|eyebrows?)$/

const DESIGN_TAGS = new Set([
  'mechanical_parts', 'mechanical_arms', 'mechanical_legs', 'mechanical_ears',
  'machinery', 'machine', 'robot_joints', 'cyborg', 'android', 'prosthesis',
  'prosthetic_leg', 'armor', 'armoured', 'armored', 'gauntlets', 'armor_plate',
  'metal', 'metallic', 'gold', 'golden', 'gold_trim', 'glowing', 'glow',
  'rigging', 'flight_deck', 'aircraft', 'ship', 'weapon', 'gun', 'sword',
  'cannon', 'missile', 'turret', 'gear', 'gears', 'sci-fi',
  'science_fiction', 'futuristic', 'technology', 'power_armor', 'exoskeleton',
])

export const TIERS = {
  T0: { key: 'T0', name: '纯风格', desc: 'WD14 tag 全删，只留触发词 + 恒定风格词', styleRequired: true },
  T1: { key: 'T1', name: '设计语言', desc: '只留设计/材质/结构类 tag', styleRequired: true },
  T2: { key: 'T2', name: '概念题材', desc: '留题材/服装/物体，删身份细节/姿势/背景', styleRequired: false },
  T3: { key: 'T3', name: '角色身份', desc: '留身份/发色/瞳色/服装，删姿势/背景/角色名', styleRequired: false },
}

export function tierOf(name) {
  const t = TIERS[name]
  if (!t) throw new Error(`未知档位 ${name}，可选：${Object.keys(TIERS).join(', ')}`)
  return t
}

export function loadCharacterNames(csvPath) {
  const names = new Set()
  if (!existsSync(csvPath)) return names
  for (const line of readFileSync(csvPath, 'utf8').trim().split('\n').slice(1)) {
    const parts = line.split(',')
    if (parts[2] === '4') names.add(parts[1].trim())
  }
  return names
}

export function keepTag(tag, tierName, charNames, extraStrip = new Set()) {
  const lc = tag.toLowerCase()
  if (ALWAYS_DROP.has(lc)) return false
  if (charNames.has(tag)) return false
  if (extraStrip.has(tag)) return false
  if (tierName === 'T0') return false
  if (tierName === 'T1') return DESIGN_TAGS.has(lc) || DESIGN_TAGS.has(tag)
  if (POSE_PREFIXES.some((p) => lc.startsWith(p))) return false
  if (tierName === 'T2' && IDENTITY_HINT.test(lc)) return false
  return true
}
