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
  router: string[]
  note?: string
  order: string[]
  drop: string[]
  rules: CanonicalRule[]
  tokenBudget: number
}

// 托底层：所有题材共用的 drop 与规范 rule，不随题材切换。
export interface CanonicalGlobal {
  drop: string[]
  rules: CanonicalRule[]
  order: string[]
}

// 题材表库：global 兜底 + 多张题材表；路由按 router 命中词打分。
export interface CanonicalBank {
  version: number
  note?: string
  tokenBudget: number
  global: CanonicalGlobal
  themes: Record<string, CanonicalTable>
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

// ---- bank：托底层 + 多题材表 + 路由打分 ----

export interface ThemeRoute {
  id: string
  score: number
}

// 按 router 命中词打分，命中数多的题材胜出；同分按 bank.themes 插入顺序取先。
export function rankThemes(tokens: string[], bank: CanonicalBank): ThemeRoute[] {
  const seen = new Set(tokens.map(normalize))
  const ranked: ThemeRoute[] = []
  for (const [id, table] of Object.entries(bank.themes)) {
    let score = 0
    for (const hit of table.router) if (seen.has(normalize(hit))) score++
    if (score > 0) ranked.push({ id, score })
  }
  ranked.sort((a, b) => b.score - a.score)
  return ranked
}

function fallbackTable(bank: CanonicalBank): CanonicalTable {
  return {
    version: bank.version,
    theme: 'global',
    router: [],
    ...(bank.note ? { note: `托底：${bank.note}` } : {}),
    order: [...bank.global.order],
    drop: [...bank.global.drop],
    rules: [...bank.global.rules],
    tokenBudget: bank.tokenBudget,
  }
}

// 命中题材：global drop ∪ theme drop；global rule 先入、theme 同 slot 覆盖；
// order 以 theme 为主，global 独有槽位追加到末尾。
export function resolveTable(
  tokens: string[],
  bank: CanonicalBank,
): { table: CanonicalTable; themeId: string | null } {
  const top = rankThemes(tokens, bank)[0]
  if (!top) return { table: fallbackTable(bank), themeId: null }
  const theme = bank.themes[top.id]
  const ruleMap = new Map<string, CanonicalRule>()
  for (const rule of bank.global.rules) ruleMap.set(rule.slot, rule)
  for (const rule of theme.rules) ruleMap.set(rule.slot, rule)
  return {
    themeId: top.id,
    table: {
      version: bank.version,
      theme: theme.theme,
      router: [...theme.router],
      ...(theme.note ? { note: theme.note } : {}),
      order: [...theme.order, ...bank.global.order.filter((slot) => !theme.order.includes(slot))],
      drop: [...new Set([...bank.global.drop, ...theme.drop])],
      rules: [...ruleMap.values()],
      tokenBudget: theme.tokenBudget ?? bank.tokenBudget,
    },
  }
}

export function recomposeBank(
  groups: PromptGroups,
  bank: CanonicalBank,
): { text: string; themeId: string | null } {
  const tokens = GROUP_KEYS.flatMap((key) => groups[key])
  const { table, themeId } = resolveTable(tokens, bank)
  return { text: recomposeCanonical(groups, table), themeId }
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

// 给定一串 WD14 tag，让 LLM 产出一张可直接入 bank 的题材表。
// 强调显式映射和专有 router：这两处最容易被 LLM「聪明地概括」写坏。
export const THEME_TABLE_SYSTEM = `你是二次元插画生产 prompt 的「题材表编译器」。
输入是一串逗号分隔的 WD14 tag（同一题材的样图打标）。输出一张题材表 JSON，用于把这个题材的长 tag 压成约 12 个词组的生产 prompt。只输出 JSON，不要解释、不要编号、不要代码块围栏。

结构：
{
  "version": 1,
  "theme": "kebab-case 题材 id",
  "note": "一句话说明这个题材的生产约束",
  "router": ["只在本题材出现、别的题材不会有的专有 tag"],
  "order": ["trigger", "identity", 本题材专用槽位..., "pose", "gaze", "other"],
  "drop": ["要丢弃的 tag"],
  "rules": [
    { "slot": "槽位名", "match": ["别名 tag"], "output": "规范词组" },
    { "slot": "槽位名", "match": ["别名 tag"], "compose": {
        "template": "{part1} {part2} item",
        "parts": {
          "part1": { "map": { "alias_tag": "输出词" }, "default": "默认词" },
          "part2": { "map": { "alias_tag": "输出词" }, "default": "默认词" }
        }
      } }
  ],
  "tokenBudget": 15
}

硬规则：
1. router 只放题材专有 tag（例如 playboy_bunny、kimono、maid_headdress），3-8 个；通用词（1girl、long_hair、looking_at_viewer）不许进 router，否则会误路由。
2. drop 放场景物件（吧台/酒杯/瓶子/家具）、重复变体、低权重身体细节（breasts/thighs/lips/skindentation）；身份词、核心服装、姿势构图不要丢。
3. rules 的 match 写全部输入中出现过的别名变体；同义词合并成一条 output 或一条 compose。
4. compose 的 parts.map 必须是显式「别名→输出词」，给出 default；禁止靠词根自动取词。一个视觉维度只出一条词组，颜色+剪裁+品类合成一条。
5. order 列出所有 slot 名，和 rules 里的 slot 对齐；本题材专有槽位排在 identity 之后、pose 之前。
6. tokenBudget 用 15。
7. theme id 用 kebab-case 英文，能和 router 对上。`

// 解析 LLM 吐出的题材表草案；结构不合法直接报错，绝不让坏表进 bank。
export function parseThemeDraft(raw: string): CanonicalTable {
  let value: unknown
  try {
    value = JSON.parse(cleanLlmText(raw))
  } catch {
    throw new Error('题材表不是合法 JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('题材表必须是 JSON 对象')
  }
  const obj = value as Record<string, unknown>
  const strList = (name: string): string[] => {
    const v = obj[name]
    if (!Array.isArray(v) || !v.every((item) => typeof item === 'string')) {
      throw new Error(`题材表 ${name} 必须是字符串数组`)
    }
    return (v as string[]).map((item) => item.trim()).filter(Boolean)
  }
  const theme = typeof obj.theme === 'string' ? obj.theme.trim() : ''
  if (theme === '') throw new Error('题材表 theme 不能为空')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(theme)) {
    throw new Error('题材表 theme 必须是 kebab-case')
  }
  const router = strList('router')
  if (router.length === 0) throw new Error('题材表 router 不能为空，否则无法路由')
  const order = strList('order')
  const drop = strList('drop')
  if (!Array.isArray(obj.rules)) throw new Error('题材表 rules 必须是数组')
  const rules: CanonicalRule[] = (obj.rules as unknown[]).map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`rules[${index}] 必须是对象`)
    }
    const rule = item as Record<string, unknown>
    if (typeof rule.slot !== 'string' || rule.slot.trim() === '') {
      throw new Error(`rules[${index}].slot 不能为空`)
    }
    const match = rule.match
    if (!Array.isArray(match) || !match.every((m) => typeof m === 'string')) {
      throw new Error(`rules[${index}].match 必须是字符串数组`)
    }
    const aliases = (match as string[]).map((m) => m.trim()).filter(Boolean)
    if (aliases.length === 0) throw new Error(`rules[${index}].match 不能为空`)
    const base = { slot: rule.slot.trim(), match: aliases }
    if (typeof rule.output === 'string' && rule.output.trim() !== '') {
      return { ...base, output: rule.output.trim() }
    }
    if (rule.compose === null || typeof rule.compose !== 'object' || Array.isArray(rule.compose)) {
      throw new Error(`rules[${index}] 需要 output 或 compose`)
    }
    const compose = rule.compose as Record<string, unknown>
    if (typeof compose.template !== 'string' || compose.template.trim() === '') {
      throw new Error(`rules[${index}].compose.template 不能为空`)
    }
    if (compose.parts === null || typeof compose.parts !== 'object' || Array.isArray(compose.parts)) {
      throw new Error(`rules[${index}].compose.parts 必须是对象`)
    }
    const parts: Record<string, CanonicalPart> = {}
    for (const [key, part] of Object.entries(compose.parts as Record<string, unknown>)) {
      if (part === null || typeof part !== 'object' || Array.isArray(part)) {
        throw new Error(`rules[${index}].compose.parts.${key} 必须是对象`)
      }
      const p = part as Record<string, unknown>
      if (p.map === null || typeof p.map !== 'object' || Array.isArray(p.map)) {
        throw new Error(`rules[${index}].compose.parts.${key}.map 必须是对象`)
      }
      const map: Record<string, string> = {}
      for (const [alias, word] of Object.entries(p.map as Record<string, unknown>)) {
        if (typeof word !== 'string' || word.trim() === '') {
          throw new Error(`rules[${index}].compose.parts.${key}.map.${alias} 必须是非空字符串`)
        }
        map[alias.trim()] = word.trim()
      }
      parts[key] = {
        map,
        ...(typeof p.default === 'string' && p.default.trim() !== '' ? { default: p.default.trim() } : {}),
      }
    }
    return { ...base, compose: { template: compose.template.trim(), parts } }
  })
  const slots = new Set(rules.map((rule) => rule.slot))
  for (const slot of slots) {
    if (!order.includes(slot)) throw new Error(`order 缺少 rules 用到的 slot: ${slot}`)
  }
  const tokenBudget =
    typeof obj.tokenBudget === 'number' && Number.isFinite(obj.tokenBudget) && obj.tokenBudget > 0
      ? Math.floor(obj.tokenBudget)
      : 15
  return {
    version: typeof obj.version === 'number' ? Math.floor(obj.version) : 1,
    theme,
    router,
    ...(typeof obj.note === 'string' && obj.note.trim() !== '' ? { note: obj.note.trim() } : {}),
    order,
    drop,
    rules,
    tokenBudget,
  }
}
