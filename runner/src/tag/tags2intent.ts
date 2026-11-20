// 图 tags → CreativeIntent 结构化 prompt。
// 词池用 data/role_full.json（wd14-tags 全表自动归类，见 experiments/build_role_full.mjs），
// 只服务归类；dice UI 仍用 data/role.json 渲染候选按钮。
// 纯函数逐函数照搬 web/components/dice-board.tsx，保证产出的 fields 能被 dice 页面
// 的 formsFromIntent 拆回各 section input（池外词走 extras 留在槽里，不丢）。
// 端到端：图 tags → placeTags → composeIntent → fields → POST /dice/rolls → /dice?rid=

export interface IntentField {
  subject: { type: string; description: string }
  outfit: { clothing: string; accessories: string[] }
  pose: { action: string; expression: string }
  composition: { shot: string; view: string; framing: string }
  environment: { background: string }
  lighting: { type: string }
  style: { genre: string; rendering: string }
  constraints: { exclude: string[] }
  repaint: { target: string; prompt: string }
}

const EMPTY_INTENT: IntentField = {
  subject: { type: '', description: '' },
  outfit: { clothing: '', accessories: [] },
  pose: { action: '', expression: '' },
  composition: { shot: '', view: '', framing: '' },
  environment: { background: '' },
  lighting: { type: '' },
  style: { genre: '', rendering: '' },
  constraints: { exclude: [] },
  repaint: { target: '', prompt: '' },
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === 'string')
}

function tagsOf(v: unknown): string[] {
  if (isStringArray(v)) return v
  if (!Array.isArray(v)) return []
  const tags: string[] = []
  for (const item of v) tags.push(...tagsOf(item))
  return tags
}

function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of tags) {
    const text = tag.trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

interface Group {
  name: string
  tags: string[]
}

function groupsOf(value: unknown): Group[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).map(([name, pool]) => ({
      name,
      tags: uniqueTags(tagsOf(pool)),
    }))
  }
  const groups = Array.isArray(value) && value.some((item) => Array.isArray(item)) ? value : [value]
  return groups
    .map((group, index) => ({
      name: groups.length > 1 ? `组 ${index + 1}` : '',
      tags: uniqueTags(tagsOf(group)),
    }))
    .filter((group) => group.tags.length > 0)
}

interface Section {
  name: string
  groups: Group[]
}

function sectionsOf(role: unknown): Section[] {
  if (!role || typeof role !== 'object' || Array.isArray(role)) return []
  return Object.entries(role as Record<string, unknown>).map(([name, value]) => ({
    name,
    groups: groupsOf(value),
  }))
}

function normTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/[\s_]+/g, '_')
}

function joinTags(tags: string[]): string {
  return tags.join(',')
}

function splitTags(value: string): string[] {
  return value.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '')
}

function tagIndexOf(orderOf: Map<string, string[]>) {
  const index = new Map<string, Array<{ section: string; canonical: string }>>()
  for (const [section, tags] of orderOf) {
    for (const tag of tags) {
      const key = normTag(tag)
      if (key === '') continue
      const list = index.get(key) ?? []
      list.push({ section, canonical: tag })
      index.set(key, list)
    }
  }
  return index
}

// 命中词按词表归位；未命中词落到 fallback section（这里固定 subject.description）。
function placeTags(
  batches: Array<{ tags: string[]; fallback: string }>,
  orderOf: Map<string, string[]>,
  index: ReturnType<typeof tagIndexOf>,
) {
  const ordered = new Map<string, Set<string>>()
  const extra = new Map<string, string[]>()
  const extraSeen = new Map<string, Set<string>>()
  for (const batch of batches) {
    for (const raw of batch.tags) {
      const text = raw.trim()
      if (text === '') continue
      const hits = index.get(normTag(text)) ?? []
      if (hits.length === 0) {
        if (!orderOf.has(batch.fallback)) continue
        const seen = extraSeen.get(batch.fallback) ?? new Set<string>()
        const key = normTag(text)
        if (seen.has(key)) continue
        seen.add(key)
        extraSeen.set(batch.fallback, seen)
        const list = extra.get(batch.fallback) ?? []
        list.push(text)
        extra.set(batch.fallback, list)
        continue
      }
      for (const hit of hits) {
        const set = ordered.get(hit.section) ?? new Set<string>()
        set.add(hit.canonical)
        ordered.set(hit.section, set)
      }
    }
  }
  const out = new Map<string, string>()
  for (const [section, known] of orderOf) {
    const picked = known.filter((tag) => ordered.get(section)?.has(tag))
    const knownNorm = new Set(picked.map(normTag))
    const rest = (extra.get(section) ?? []).filter((tag) => !knownNorm.has(normTag(tag)))
    out.set(section, joinTags([...picked, ...rest]))
  }
  return out
}

function partsOf(input: string, ordered: string[]) {
  const byLength = [...ordered].sort((a, b) => b.length - a.length)
  const known = new Set<string>()
  const extras: string[] = []
  const extraSeen = new Set<string>()
  let pending = ''
  const flush = () => {
    const piece = pending.trim().replace(/^,+|,+$/g, '').trim()
    pending = ''
    if (piece === '') return
    const key = normTag(piece)
    if (key === '' || extraSeen.has(key) || [...known].some((tag) => normTag(tag) === key)) return
    extraSeen.add(key)
    extras.push(piece)
  }
  let i = 0
  const text = input.trim()
  while (i < text.length) {
    while (i < text.length && (text[i] === ',' || text[i] === '\n')) i += 1
    if (i >= text.length) break
    const slice = text.slice(i)
    const spaceStartsTag = byLength.some((tag) => tag.startsWith(' ') && slice.startsWith(tag))
    if (!spaceStartsTag && text[i] === ' ') {
      pending += text[i]
      i += 1
      continue
    }
    const hit = byLength.find((tag) => {
      if (!slice.startsWith(tag)) return false
      const next = slice[tag.length]
      return next === undefined || next === ',' || next === '\n'
    })
    if (!hit) {
      const next = text.indexOf(',', i)
      const end = next === -1 ? text.length : next
      pending += text.slice(i, end)
      flush()
      i = next === -1 ? text.length : next + 1
      continue
    }
    flush()
    known.add(hit)
    i += hit.length
  }
  flush()
  return { known, extras }
}

function tokensOf(text: string, ordered: string[]) {
  if (ordered.length === 0) return splitTags(text)
  const { known, extras } = partsOf(text, ordered)
  return [...ordered.filter((tag) => known.has(tag)), ...extras]
}

function mergeSlots(form: { character: string; pose: string; reference?: string; input: string }, ordered: string[] = []) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of [form.character, form.pose, form.reference ?? '', form.input]) {
    for (const tag of tokensOf(part, ordered)) {
      const key = normTag(tag)
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      out.push(tag)
    }
  }
  return out
}

function writeField(record: Record<string, string | string[]>, field: string, tags: string[]) {
  if (!(field in record)) return
  if (Array.isArray(record[field])) record[field] = tags
  else record[field] = tags.join(',')
}

function sectionOrder(section: Section): string[] {
  return uniqueTags(section.groups.flatMap((group) => group.tags))
}

function composeIntent(sections: Section[], forms: Record<string, { character: string; pose: string; reference?: string; input: string }>) {
  const intent = structuredClone(EMPTY_INTENT) as unknown as Record<
    string,
    Record<string, string | string[]>
  >
  for (const section of sections) {
    const dot = section.name.indexOf('.')
    if (dot < 1) continue
    const group = section.name.slice(0, dot)
    const field = section.name.slice(dot + 1)
    const parent = intent[group]
    if (!parent || typeof parent !== 'object') continue
    const record = parent
    if (!(field in record)) continue
    const ordered = sectionOrder(section)
    const tags = mergeSlots(forms[section.name] ?? { pose: '', character: '', reference: '', input: '' }, ordered)
    const used = new Set<string>()
    for (const subgroup of section.groups) {
      if (subgroup.name === '' || subgroup.name === field || !(subgroup.name in record)) continue
      const member = new Set(subgroup.tags.map(normTag))
      const picked = tags.filter((tag) => member.has(normTag(tag)) && !used.has(normTag(tag)))
      for (const tag of picked) used.add(normTag(tag))
      writeField(record, subgroup.name, picked)
    }
    writeField(record, field, tags.filter((tag) => !used.has(normTag(tag))))
  }
  return intent as unknown as IntentField
}

function promptOf(intent: IntentField) {
  const seen = new Set<string>()
  const positive: string[] = []
  for (const item of [
    intent.subject.type,
    intent.subject.description,
    intent.outfit.clothing,
    ...intent.outfit.accessories,
    intent.pose.action,
    intent.pose.expression,
    intent.composition.shot,
    intent.composition.view,
    intent.composition.framing,
    intent.environment.background,
    intent.lighting.type,
    intent.style.genre,
    intent.style.rendering,
  ]) {
    for (const tag of splitTags(item)) {
      const key = normTag(tag)
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      positive.push(tag)
    }
  }
  return { positive: positive.join(','), negative: intent.constraints.exclude.join(',') }
}

interface CompiledRole {
  sections: Section[]
  orderOf: Map<string, string[]>
  tagIndex: ReturnType<typeof tagIndexOf>
  vocab: Set<string>
}

function compileRole(role: unknown): CompiledRole {
  const sections = sectionsOf(role)
  const orderOf = new Map(sections.map((s) => [s.name, uniqueTags(s.groups.flatMap((g) => g.tags))]))
  const tagIndex = tagIndexOf(orderOf)
  return { sections, orderOf, tagIndex, vocab: new Set(tagIndex.keys()) }
}

export interface FieldForm {
  character: string
  pose: string
  reference: string
  input: string
}

export interface TagIntentResult {
  intent: IntentField
  forms: Record<string, FieldForm>
  positive: string
  negative: string
  total: number
  hit: number
  miss: number
}

// 把一张图的 tags 拆进 CreativeIntent。未命中词落 subject.description（保留信息，不丢词）。
// 归类词放在 reference 槽——表示来源是图库导入；dice 回填时各槽原样还原，可逆编辑。
export function tagsToIntent(tags: string[], compiled: CompiledRole): TagIntentResult {
  const total = tags.length
  const hit = tags.filter((t) => compiled.vocab.has(normTag(t))).length
  const placed = placeTags([{ tags, fallback: 'subject.description' }], compiled.orderOf, compiled.tagIndex)
  const forms = Object.fromEntries(
    compiled.sections.map((section) => [
      section.name,
      { character: '', pose: '', reference: placed.get(section.name) ?? '', input: '' },
    ]),
  )
  const intent = composeIntent(compiled.sections, forms)
  const prompt = promptOf(intent)
  return { intent, forms, positive: prompt.positive, negative: prompt.negative, total, hit, miss: total - hit }
}

export function compileRolePool(role: unknown): CompiledRole {
  return compileRole(role)
}
