// 首页 prompt 工作台纯逻辑：平铺 prompt → 四组 → 生产 prompt。
// 不碰 tags2intent / role_full 那套结构化 prompt（项目其他地方保持原样）。
// 分档词表复用 tag-groups.ts 的分类思路，但这里只分用户要的四组。

export interface PromptGroups {
  trigger: string[]
  identity: string[]
  clothing: string[]
  pose: string[]
}

export type PromptGroupKey = keyof PromptGroups

export const GROUP_KEYS: PromptGroupKey[] = ['trigger', 'identity', 'clothing', 'pose']

export const GROUP_LABELS: Record<PromptGroupKey, string> = {
  trigger: '触发词与质量',
  identity: '外貌与身份',
  clothing: '服装与题材',
  pose: '姿势与构图',
}

// 触发词：项目自造 trigger（zx 前缀）、lora 语法、尖括号钩子
const TRIGGER_PATTERN = /^(zx|<|\[|<lora:)/i

// 质量/画风词：归到「触发词与质量」组，生产重组时按预算优先保留
const QUALITY = new Set([
  'masterpiece', 'best quality', 'high quality', 'ultra-detailed', 'highly detailed',
  'very detailed', 'detail', 'sharp focus', 'focus', '8k', '4k', 'highres', 'absurdres',
  'semi-realistic', 'realistic', 'painterly', 'painterly rendering', 'illustration',
  'cinematic', 'dramatic lighting', 'cinematic lighting', 'high contrast',
  'volumetric lighting', 'rim light', 'studio lighting', 'ambient occlusion',
])

// 主体人数与身份细节（和 tag-groups.ts 保持一致）
const SUBJECT = /^(1girl|2girls|3girls|multiple_girls|1boy|2boys|multiple_boys|solo|group|no_humans)$/i
const IDENTITY_HINT = /(?:^|_)(eyes?|hair|iris|pupils?|expression|smile|blush|mouth|ears?|tail|horns?|skin|breasts?|ass|thighs?|clavicle|eyebrows?)$/i

// 姿势动作 / 景别镜头
const POSE = new Set([
  'sitting', 'standing', 'kneeling', 'lying', 'squatting', 'crouching',
  'walking', 'running', 'looking_at_viewer', 'looking_away', 'wink',
])
const POSE_PREFIX = ['sitting', 'standing', 'kneeling', 'lying', 'arms_', 'arm_up', 'crossed_legs', 'one_eye_closed']
const CAMERA = new Set([
  'dutch_angle', 'cowboy_shot', 'close-up', 'close_up', 'portrait',
  'full_body', 'upper_body', 'mid_shot', 'wide_shot', 'long_shot',
])
const CAMERA_PREFIX = ['from_', 'camera_', 'view_from', 'perspective']

function keyOf(token: string): PromptGroupKey {
  const lc = token.toLowerCase().replace(/\s+/g, '_')
  if (TRIGGER_PATTERN.test(token) || QUALITY.has(token.toLowerCase())) return 'trigger'
  if (CAMERA.has(lc) || CAMERA_PREFIX.some((p) => lc.startsWith(p))) return 'pose'
  if (POSE.has(lc) || POSE_PREFIX.some((p) => lc.startsWith(p))) return 'pose'
  if (SUBJECT.test(lc) || IDENTITY_HINT.test(lc)) return 'identity'
  return 'clothing'
}

// 组内排序：触发词优先 trigger 钩子，其次质量词；身份组人数词优先；其余字母序。
function sortGroup(key: PromptGroupKey, tokens: string[]): string[] {
  const rank = (token: string): number => {
    const lc = token.toLowerCase()
    if (key === 'trigger') return TRIGGER_PATTERN.test(token) ? 0 : 1
    if (key === 'identity' && SUBJECT.test(lc.replace(/\s+/g, '_'))) return 0
    return 2
  }
  return [...tokens].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    return a.toLowerCase().localeCompare(b.toLowerCase())
  })
}

// 平铺 prompt → 四组；去重（大小写不敏感）、组内排序。
export function splitPrompt(text: string): PromptGroups {
  const groups: PromptGroups = { trigger: [], identity: [], clothing: [], pose: [] }
  const seen = new Set<string>()
  for (const raw of text.split(/[,，\n]/)) {
    const token = raw.trim()
    if (token === '') continue
    const lc = token.toLowerCase()
    if (seen.has(lc)) continue
    seen.add(lc)
    groups[keyOf(token)].push(token)
  }
  for (const key of GROUP_KEYS) groups[key] = sortGroup(key, groups[key])
  return groups
}

// 四组 → 平铺 prompt（生成时用的顺序）
export function joinGroups(groups: PromptGroups): string {
  return GROUP_KEYS.flatMap((key) => groups[key]).join(', ')
}

// 兼容 API 入参：数组或逗号串都收
export function groupsFrom(value: unknown): PromptGroups {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('groups must be an object')
  }
  const src = value as Record<string, unknown>
  const out = {} as PromptGroups
  for (const key of GROUP_KEYS) {
    const raw = src[key]
    if (raw === undefined || raw === null) {
      out[key] = []
    } else if (Array.isArray(raw) && raw.every((v) => typeof v === 'string')) {
      out[key] = (raw as string[]).map((v) => v.trim()).filter(Boolean)
    } else if (typeof raw === 'string') {
      out[key] = raw.split(/[,，\n]/).map((v) => v.trim()).filter(Boolean)
    } else {
      throw new Error(`groups.${key} must be a string or string[]`)
    }
  }
  return out
}

// ---- canonical 表：换题材维护这一个 JSON，结果逐字可复现 ----

export interface CanonicalPart {
  // token(normalize) → 输出词。显式映射，保证逐字可复现。
  map: Record<string, string>
  default?: string
}

export interface CanonicalRule {
  slot: string
  match: string[]
  output?: string
  compose?: { template: string; parts: Record<string, CanonicalPart> }
}

export interface CanonicalTable {
  version: number
  theme: string
  note?: string
  order: string[]
  drop: string[]
  rules: CanonicalRule[]
  tokenBudget: number
}

function normalize(token: string): string {
  return token.trim().toLowerCase().replace(/\s+/g, '_')
}

// 确定性重组：drop 丢弃 → 规则命中出规范词 → 未命中原样保留 → 按 order 排序 → 预算截断。
export function recomposeCanonical(groups: PromptGroups, table: CanonicalTable): string {
  const tokens = GROUP_KEYS.flatMap((key) => groups[key])
  const dropped = new Set(table.drop.map(normalize))
  const passthrough: Array<{ key: PromptGroupKey; text: string }> = []
  const emitted = new Map<string, string>()

  const aliasToRule = new Map<string, CanonicalRule>()
  for (const rule of table.rules) {
    for (const alias of rule.match) aliasToRule.set(normalize(alias), rule)
  }

  const matchedRules = new Set<CanonicalRule>()
  for (const key of GROUP_KEYS) {
    for (const token of groups[key]) {
      const lc = normalize(token)
      if (dropped.has(lc)) continue
      const rule = aliasToRule.get(lc)
      if (!rule) {
        passthrough.push({ key, text: token })
        continue
      }
      matchedRules.add(rule)
    }
  }

  for (const rule of table.rules) {
    if (!matchedRules.has(rule)) continue
    if (rule.output) {
      emitted.set(rule.slot, rule.output)
      continue
    }
    if (rule.compose) {
      const parts: Record<string, string> = {}
      for (const [name, part] of Object.entries(rule.compose.parts)) {
        // 找到第一个命中该 part 任一 alias 的 token，取它映射到的输出词
        const hit = tokens.find((token) => Object.hasOwn(part.map, normalize(token)))
        parts[name] = hit ? (part.map[normalize(hit)] ?? part.default ?? '') : (part.default ?? '')
      }
      const text = rule.compose.template.replace(/\{(\w+)\}/g, (_, name: string) => parts[name] ?? '')
      emitted.set(rule.slot, text.replace(/\s+/g, ' ').trim())
    }
  }

  // slot 顺序：表里的 order 优先；未在表里登记的 passthrough 用其所属组的组名兜底
  const GROUP_SLOT: Record<PromptGroupKey, string> = {
    trigger: 'trigger', identity: 'identity', clothing: 'other', pose: 'pose',
  }
  const slotRank = new Map(table.order.map((slot, index) => [slot, index]))
  const items: Array<{ slot: string; text: string }> = [
    ...[...emitted.entries()].map(([slot, text]) => ({ slot, text })),
    ...passthrough.map(({ key, text }) => ({ slot: GROUP_SLOT[key], text })),
  ]
  items.sort((a, b) => {
    const ra = slotRank.get(a.slot) ?? (slotRank.get('other') ?? 999)
    const rb = slotRank.get(b.slot) ?? (slotRank.get('other') ?? 999)
    return ra - rb
  })
  return items.slice(0, table.tokenBudget).map((item) => item.text).join(', ')
}

// chat gateway 一次做完「维度去重 + 生产重组」（前面四步里的第 3、4 步）
export const RECOMPOSE_SYSTEM = `你是二次元插画的生产 prompt 编译器。
输入是 WD14 打标词（逗号分隔）。输出一条不超过 15 个词组的生产 prompt。
硬规则：
1. 一个视觉维度只留一个最强描述；同义词、变体（如 leotard / black_leotard / highleg_leotard）合并成一条。
2. 颜色 + 剪裁 + 品类合成一条词组，例如 black highleg leotard；不要拆成多行。
3. 删除场景物件（酒杯/吧台/瓶子）、重复变体、低权重身体细节（thighs/legs/lips/skindentation）。
4. 保留主体身份（1girl/solo）、头饰、服装、姿势与构图。
5. 只输出 prompt 本身，不要解释、不要编号、不要引号。`

export function cleanLlmText(text: string): string {
  return text
    .trim()
    .replace(/^```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?```$/, '')
    .trim()
}
