// caption 自动过滤档位 —— runner 侧真相源。
// web 训练页（/train/start）与辅助脚本（scripts_and_tools/caption_tiers.mjs）都按这套规则。
//
// 核心机制：caption token 出现在【所有】训练图 → 绑到触发词 = 风格/概念；
// 只出现在【部分】图 → 绑到那部分个性 = 内容，稀释风格。
// 档位决定「WD14 tag 留多少」；恒定风格词由调用方给，每张图都一样。

export const TIER_NAMES = ['T0', 'T1', 'T2', 'T3'] as const
export type TierName = (typeof TIER_NAMES)[number]

export type TierDef = {
  // 档位 key，如 T0
  key: TierName
  // 中文名
  name: string
  desc: string
  // 恒定风格词是否必填（T0/T1 全靠它承载风格）
  styleRequired: boolean
}

export const TIERS: Record<TierName, TierDef> = {
  T0: {
    key: 'T0',
    name: '纯风格',
    desc: 'WD14 tag 全删，只留触发词 + 恒定风格词。适合内容杂、只锁画法。',
    styleRequired: true,
  },
  T1: {
    key: 'T1',
    name: '设计语言',
    desc: '只留设计/材质/结构类 tag（装甲、金属、机械），其余删。锁定黑金厚重这类设计特征。',
    styleRequired: true,
  },
  T2: {
    key: 'T2',
    name: '概念题材',
    desc: '留题材/服装/物体，删人物身份细节、姿势、背景、画质。锁定「舰娘」这类题材。',
    styleRequired: false,
  },
  T3: {
    key: 'T3',
    name: '角色身份',
    desc: '留身份/发色/瞳色/服装，删姿势构图、背景、画质、角色名。锁定某个角色。',
    styleRequired: false,
  },
}

// 所有档都删：绑进 LoRA 会把背景/画质锁死
export const ALWAYS_DROP = new Set([
  'white_background', 'black_background', 'gray_background', 'grey_background',
  'simple_background', 'solid_color_background', 'solid_background',
  'transparent_background', 'plain_background', 'gradient_background',
  'colored_background', 'black_border', 'border',
  'lowres', 'worst_quality', 'low_quality', 'blurry', 'watermark',
  'signature', 'username', 'artist_name', 'text', 'error',
])

// 姿势/构图/视角：由双 CN 或推理 prompt 控制，不进 caption（否则绑进触发词）
const POSE_PREFIXES = [
  'sitting', 'standing', 'looking_at', 'looking_to', 'from_', 'cowboy_shot',
  'full_body', 'upper_body', 'close-up', 'close_up', 'portrait', 'arms_',
  'arm_up', 'crossed_legs', 'lying', 'kneeling', 'one_eye_closed',
]

// 人物身份细节：T2（概念题材）删；T3（角色身份）留
const IDENTITY_HINT = /(?:^|_)(eyes?|hair|iris|pupils?|expression|smile|blush|mouth|ears?|tail|horns?|skin|breasts?|ass|thighs?|clavicle|eyebrows?)$/

// 设计/材质/结构白名单：T1 只留这些。默认一组机械/舰装词，调用方可扩充。
const DESIGN_TAGS = new Set([
  'mechanical_parts', 'mechanical_arms', 'mechanical_legs', 'mechanical_ears',
  'machinery', 'machine', 'robot_joints', 'cyborg', 'android', 'prosthesis',
  'prosthetic_leg', 'armor', 'armoured', 'armored', 'gauntlets', 'armor_plate',
  'metal', 'metallic', 'gold', 'golden', 'gold_trim', 'glowing', 'glow',
  'rigging', 'flight_deck', 'aircraft', 'ship', 'weapon', 'gun', 'sword',
  'cannon', 'missile', 'turret', 'gear', 'gears', 'sci-fi',
  'science_fiction', 'futuristic', 'technology', 'power_armor', 'exoskeleton',
])

function isTier(name: string): name is TierName {
  return (TIER_NAMES as readonly string[]).includes(name)
}

export function normalizeTier(value: unknown): TierName | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !isTier(value.trim().toUpperCase())) {
    const names = [...TIER_NAMES, '（留空=原样）'].join(' / ')
    throw new Error(`未知 caption 档位：${String(value)}（可用 ${names}）`)
  }
  return value.trim().toUpperCase() as TierName
}

// 单 tag 在某档下是否保留。charNames 为 WD14 category=4 角色名集合。
export function keepTag(
  tag: string,
  tier: TierName,
  charNames: ReadonlySet<string>,
): boolean {
  const lc = tag.toLowerCase()
  if (ALWAYS_DROP.has(lc)) return false
  if (charNames.has(tag)) return false

  if (tier === 'T0') return false

  if (tier === 'T1') {
    return DESIGN_TAGS.has(lc) || DESIGN_TAGS.has(tag)
  }

  // T2/T3 都剥姿势构图
  if (POSE_PREFIXES.some((p) => lc.startsWith(p))) return false

  if (tier === 'T2' && IDENTITY_HINT.test(lc)) return false

  return true
}

export type CaptionOpts = {
  trigger: string
  tier: TierName | null
  styleTags: readonly string[]
  charNames: ReadonlySet<string>
}

// 拼一条 caption：触发词永远首位（SDXL 对 token 位置敏感），恒定风格词紧随，
// 再接按档位过滤后保留的 WD14 tag。tier=null 走旧行为（trigger + 全量 tag）。
export function captionFor(tags: readonly string[], opts: CaptionOpts): string {
  const trigger = opts.trigger.trim()
  if (!opts.tier) {
    const kept = opts.charNames.size
      ? tags.filter((tag) => !opts.charNames.has(tag))
      : tags
    return `${trigger ? `${trigger}, ` : ''}${kept.join(',')},`
  }
  const kept = tags.filter((tag) => keepTag(tag, opts.tier!, opts.charNames))
  const parts = [trigger, ...opts.styleTags, ...kept].filter((s) => s.length > 0)
  return `${parts.join(', ')},`
}
