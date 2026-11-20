'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Dialog } from '@/components/dialog'
import { TaskDetail } from '@/components/task-detail'
import { api } from '@/lib/api'
import { initialIntent, type CreativeIntent } from '@/lib/intent'
import { fail, messageOf, notify } from '@/lib/notify'

// 造型页：顶部先选角色再选 pose，分别写入各字段的 character / pose。
// 卡片输入顺序与选择顺序一致：角色、pose、input。
// role.json 的词只作快速输入；已经由角色或 pose 写入的词在候选里不可再选。
// 生成按角色、pose、input 合成 CreativeIntent。

const FORM_KEYS = ['character', 'pose', 'reference', 'input'] as const

type FormKey = (typeof FORM_KEYS)[number]

const FIELD_LABEL: Record<FormKey, string> = {
  character: '角色',
  pose: 'pose',
  reference: '参考图',
  input: 'input',
}

interface FieldForm {
  pose: string
  character: string
  reference: string
  input: string
}

interface PoseEntry {
  id: string
  poseName: string
  name?: string
  tags?: string[]
  guide?: { view?: string[]; shot?: string[]; framing?: string[] }
  variants?: Record<string, { depth?: string }>
}

interface CharacterSummary {
  slug: string
  display?: string
  preview?: string | null
}

interface CharacterRecipe {
  display?: { zh?: string; en?: string }
  person?: {
    character_tag?: string
    series_tag?: string
    tags?: string[]
  }
  outfits?: Record<
    string,
    {
      label?: string
      tags?: string[]
      layers?: { base?: string[]; wear?: string[]; gear?: string[] }
    }
  >
  negative_tags?: string[]
}

interface TagGroup {
  name: string
  tags: string[]
}

interface RoleSection {
  name: string
  groups: TagGroup[]
}

interface TagBatch {
  tags: string[]
  fallback: string
}

interface TagHit {
  section: string
  canonical: string
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function tagsOf(value: unknown): string[] {
  if (isStringArray(value)) return value
  if (!Array.isArray(value)) return []
  const tags: string[] = []
  for (const item of value) tags.push(...tagsOf(item))
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

function groupsOf(value: unknown): TagGroup[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).map(([name, pool]) => ({
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

function sectionsOf(role: unknown): RoleSection[] {
  if (!role || typeof role !== 'object' || Array.isArray(role)) return []
  return Object.entries(role as Record<string, unknown>).map(([name, value]) => ({
    name,
    groups: groupsOf(value),
  }))
}

function emptyForm(): FieldForm {
  return { pose: '', character: '', reference: '', input: '' }
}

function formsOf(sections: RoleSection[]): Record<string, FieldForm> {
  return Object.fromEntries(sections.map((section) => [section.name, emptyForm()]))
}

function normTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/[\s_]+/g, '_')
}

function textList(...values: Array<string | string[] | undefined>): string[] {
  const out: string[] = []
  for (const value of values) {
    if (typeof value === 'string') out.push(value)
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') out.push(item)
      }
    }
  }
  return out
}

function tagIndexOf(orderOf: Map<string, string[]>): Map<string, TagHit[]> {
  const index = new Map<string, TagHit[]>()
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

// 命中 role.json 的词写回该词表里的写法，并按原顺序排列。对不上的词落到 fallback 字段末尾。
function placeTags(
  batches: TagBatch[],
  orderOf: Map<string, string[]>,
  index: Map<string, TagHit[]>,
): Map<string, string> {
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

function outfitTags(recipe: CharacterRecipe): string[] {
  const outfit = recipe.outfits?.default
  if (!outfit) return []
  if (Array.isArray(outfit.tags) && outfit.tags.length > 0) return outfit.tags
  const layers = outfit.layers
  return textList(layers?.base, layers?.wear, layers?.gear)
}

function characterBatches(recipe: CharacterRecipe): TagBatch[] {
  const person = recipe.person ?? {}
  return [
    { tags: textList(person.character_tag, person.series_tag), fallback: 'subject.type' },
    { tags: textList(person.tags), fallback: 'subject.description' },
    { tags: outfitTags(recipe), fallback: 'outfit.clothing' },
    { tags: textList(recipe.negative_tags), fallback: 'constraints.exclude' },
  ]
}

function poseBatches(entry: PoseEntry, orderOf: Map<string, string[]>): TagBatch[] {
  const framing = orderOf.has('composition.framing') ? 'composition.framing' : 'composition.shot'
  return [
    { tags: textList(entry.poseName, entry.tags), fallback: 'pose.action' },
    { tags: textList(entry.guide?.shot), fallback: 'composition.shot' },
    { tags: textList(entry.guide?.view), fallback: 'composition.view' },
    { tags: textList(entry.guide?.framing), fallback: framing },
  ]
}

// 从文本里认出 role.json 的词，其余片段保留。词本身可以含逗号或空格，按最长匹配切。
function partsOf(input: string, ordered: string[]): { known: Set<string>; extras: string[] } {
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
  let index = 0
  const text = input.trim()
  while (index < text.length) {
    while (index < text.length && (text[index] === ',' || text[index] === '\n')) index += 1
    if (index >= text.length) break
    const slice = text.slice(index)
    const spaceStartsTag = byLength.some((tag) => tag.startsWith(' ') && slice.startsWith(tag))
    if (!spaceStartsTag && text[index] === ' ') {
      pending += text[index]
      index += 1
      continue
    }
    const hit = byLength.find((tag) => {
      if (!slice.startsWith(tag)) return false
      const next = slice[tag.length]
      return next === undefined || next === ',' || next === '\n'
    })
    if (!hit) {
      const next = text.indexOf(',', index)
      const end = next === -1 ? text.length : next
      pending += text.slice(index, end)
      flush()
      index = next === -1 ? text.length : next + 1
      continue
    }
    flush()
    known.add(hit)
    index += hit.length
  }
  flush()
  return { known, extras }
}

function selectedTags(input: string, ordered: string[]): string[] {
  const { known } = partsOf(input, ordered)
  return ordered.filter((tag) => known.has(tag))
}

function appendTag(current: string, tag: string, ordered: string[]): string {
  const text = tag.trim()
  if (text === '') return current
  const { known, extras } = partsOf(current, ordered)
  const key = normTag(text)
  if ([...known].some((item) => normTag(item) === key) || extras.some((item) => normTag(item) === key)) {
    return current
  }
  const canonical = ordered.find((item) => normTag(item) === key)
  if (canonical) known.add(canonical)
  else extras.push(text)
  return joinTags([...ordered.filter((item) => known.has(item)), ...extras])
}

function removeTag(current: string, tag: string, ordered: string[]): string {
  const key = normTag(tag)
  if (key === '') return current
  const { known, extras } = partsOf(current, ordered)
  for (const item of known) {
    if (normTag(item) === key) known.delete(item)
  }
  return joinTags([
    ...ordered.filter((item) => known.has(item)),
    ...extras.filter((item) => normTag(item) !== key),
  ])
}

function joinTags(tags: string[]): string {
  return tags.join(',')
}

function splitTags(value: string): string[] {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '')
}

function fieldText(value: unknown): string {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').join(',')
  if (typeof value === 'string') return value
  return ''
}

function sectionOrder(section: RoleSection): string[] {
  return uniqueTags(section.groups.flatMap((group) => group.tags))
}

function tokensOf(text: string, ordered: string[]): string[] {
  if (ordered.length === 0) return splitTags(text)
  const { known, extras } = partsOf(text, ordered)
  return [...ordered.filter((tag) => known.has(tag)), ...extras]
}

function mergeSlots(form: FieldForm, ordered: string[] = []): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of [form.character, form.pose, form.reference, form.input]) {
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

function composeIntent(sections: RoleSection[], forms: Record<string, FieldForm>): CreativeIntent {
  const intent = structuredClone(initialIntent)
  for (const section of sections) {
    const dot = section.name.indexOf('.')
    if (dot < 1) continue
    const group = section.name.slice(0, dot)
    const field = section.name.slice(dot + 1)
    const parent = intent[group as keyof CreativeIntent]
    if (!parent || typeof parent !== 'object') continue
    const record = parent as Record<string, string | string[]>
    if (!(field in record)) continue
    const ordered = sectionOrder(section)
    const tags = mergeSlots(forms[section.name] ?? emptyForm(), ordered)
    const used = new Set<string>()
    for (const subgroup of section.groups) {
      if (subgroup.name === '' || subgroup.name === field || !(subgroup.name in record)) continue
      const member = new Set(subgroup.tags.map(normTag))
      const picked = tags.filter((tag) => member.has(normTag(tag)) && !used.has(normTag(tag)))
      for (const tag of picked) used.add(normTag(tag))
      writeField(record, subgroup.name, picked)
    }
    writeField(
      record,
      field,
      tags.filter((tag) => !used.has(normTag(tag))),
    )
  }
  return intent
}

function promptOf(intent: CreativeIntent): { positive: string; negative: string } {
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

function assetUrl(prefix: 'pose-file' | 'character-file', path: string | null | undefined): string | null {
  if (!path) return null
  return `/api/runner/data/${prefix}/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
}

function depthUrl(entry: PoseEntry): string | null {
  for (const variant of Object.values(entry.variants ?? {})) {
    const depth = variant?.depth
    if (depth) {
      return assetUrl('pose-file', depth)
    }
  }
  return null
}

function formsFromIntent(sections: RoleSection[], fields: unknown): Record<string, FieldForm> {
  const forms = formsOf(sections)
  const root =
    fields && typeof fields === 'object' && !Array.isArray(fields)
      ? (fields as Record<string, unknown>)
      : {}
  for (const section of sections) {
    const dot = section.name.indexOf('.')
    if (dot < 1) continue
    const group = root[section.name.slice(0, dot)]
    const field = section.name.slice(dot + 1)
    const parent =
      group && typeof group === 'object' && !Array.isArray(group)
        ? (group as Record<string, unknown>)
        : {}
    const chunks = [fieldText(parent[field])]
    for (const subgroup of section.groups) {
      if (subgroup.name === '' || subgroup.name === field || !(subgroup.name in parent)) continue
      chunks.push(fieldText(parent[subgroup.name]))
    }
    const ordered = sectionOrder(section)
    const { known, extras } = partsOf(chunks.filter((chunk) => chunk !== '').join(','), ordered)
    forms[section.name] = {
      pose: '',
      character: '',
      reference: '',
      input: joinTags([...ordered.filter((tag) => known.has(tag)), ...extras]),
    }
  }
  return forms
}

// 灵感记录带的带来源 forms：各槽原样还原，实现「可逆向重新编辑」。
// 旧记录没有 forms（空）时返回 null，调用方回退到 formsFromIntent（按 fields 拆词）。
function formsFromStored(sections: RoleSection[], raw: unknown): Record<string, FieldForm> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const stored = raw as Record<string, unknown>
  const known = new Set(sections.map((section) => section.name))
  if (!Object.keys(stored).some((key) => known.has(key))) return null
  const next = formsOf(sections)
  for (const section of sections) {
    const value = stored[section.name]
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const part = value as Record<string, unknown>
    const text = (key: FormKey): string => (typeof part[key] === 'string' ? (part[key] as string) : '')
    next[section.name] = {
      character: text('character'),
      pose: text('pose'),
      reference: text('reference'),
      input: text('input'),
    }
  }
  return next
}

interface DiceTemplate {
  id: string
  name: string
  character: string | null
  poseName: string | null
  poseId: string | null
  fields: CreativeIntent
  forms?: unknown
}

function writeSlot(
  forms: Record<string, FieldForm>,
  names: string[],
  slot: 'pose' | 'character',
  values: Map<string, string>,
): Record<string, FieldForm> {
  const next = { ...forms }
  for (const name of names) {
    const form = next[name] ?? emptyForm()
    next[name] = { ...form, [slot]: values.get(name) ?? '' }
  }
  return next
}

export function DiceBoard({ role }: { role: unknown }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const taskId = searchParams.get('tid') ?? ''
  const rollId = searchParams.get('rid') ?? ''
  const appliedRoll = useRef('')
  const sections = useMemo(() => sectionsOf(role), [role])
  const sectionNames = useMemo(() => sections.map((section) => section.name), [sections])
  const [forms, setForms] = useState<Record<string, FieldForm>>(() => formsOf(sections))
  const [characters, setCharacters] = useState<CharacterSummary[]>([])
  const [characterSlug, setCharacterSlug] = useState('')
  const [characterNote, setCharacterNote] = useState('')
  const [poses, setPoses] = useState<PoseEntry[]>([])
  const [poseId, setPoseId] = useState('')
  const [poseError, setPoseError] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [promptView, setPromptView] = useState<'fields' | 'joined'>('joined')
  const [saving, setSaving] = useState(false)
  const [templates, setTemplates] = useState<DiceTemplate[]>([])
  const [templateId, setTemplateId] = useState('')
  const [templateOpen, setTemplateOpen] = useState(false)
  const [pickedId, setPickedId] = useState('')
  const [templateDraft, setTemplateDraft] = useState('')
  const [focus, setFocus] = useState<{ section: string; key: FormKey } | null>(null)
  const [recommendations, setRecommendations] = useState<string[]>([])
  const [recStatus, setRecStatus] = useState('')
  const characterRequest = useRef(0)
  const recRequest = useRef(0)
  const blurTimer = useRef<number | undefined>(undefined)
  const formsRef = useRef(forms)
  formsRef.current = forms

  useEffect(() => {
    if (rollId === '' || appliedRoll.current === rollId) return
    let cancelled = false
    void (async () => {
      try {
        const body = await api<{
          roll: { fields: unknown; forms?: unknown; poseId: string | null }
        }>(`dice/rolls/${rollId}`)
        if (cancelled || appliedRoll.current === rollId) return
        appliedRoll.current = rollId
        characterRequest.current += 1
        // 优先带来源的 forms（可逐槽逆编辑）；旧记录无 forms 时回退按 fields 拆词。
        const next = formsFromStored(sections, body.roll.forms) ?? formsFromIntent(sections, body.roll.fields)
        formsRef.current = next
        setCharacterSlug('')
        setCharacterNote('')
        setTemplateId('')
        setPoseId(body.roll.poseId ?? '')
        setForms(next)
        setPreviewOpen(true)
      } catch (err) {
        if (!cancelled) fail(messageOf(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [rollId, sections])

  const orderOf = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const section of sections) {
      map.set(section.name, uniqueTags(section.groups.flatMap((group) => group.tags)))
    }
    return map
  }, [sections])
  const tagIndex = useMemo(() => tagIndexOf(orderOf), [orderOf])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [poseBody, characterBody, templateBody] = await Promise.all([
          api<{ poses: PoseEntry[] }>('data/poses?enabled=true'),
          api<{ characters: CharacterSummary[] }>('data/characters'),
          api<{ templates: DiceTemplate[] }>('dice/templates'),
        ])
        if (cancelled) return
        setPoses(poseBody.poses)
        setCharacters(characterBody.characters)
        setTemplates(templateBody.templates)
      } catch (err) {
        if (cancelled) return
        const message = messageOf(err)
        setPoseError(message)
        fail(message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const applyCharacter = useCallback(
    (recipe: CharacterRecipe | null) => {
      const values = placeTags(recipe ? characterBatches(recipe) : [], orderOf, tagIndex)
      setForms((cur) => writeSlot(cur, sectionNames, 'character', values))
    },
    [orderOf, tagIndex, sectionNames],
  )

  const applyPose = useCallback(
    (entry: PoseEntry | null) => {
      const values = placeTags(entry ? poseBatches(entry, orderOf) : [], orderOf, tagIndex)
      setForms((cur) => writeSlot(cur, sectionNames, 'pose', values))
    },
    [orderOf, tagIndex, sectionNames],
  )

  const chooseCharacter = useCallback(
    (slug: string) => {
      const request = characterRequest.current + 1
      characterRequest.current = request
      setCharacterSlug(slug)
      if (slug === '') {
        setCharacterNote('')
        applyCharacter(null)
        return
      }
      void (async () => {
        try {
          const body = await api<{ recipe: CharacterRecipe | null }>(`data/characters/${slug}`)
          if (characterRequest.current !== request) return
          const recipe = body.recipe
          const name = recipe?.display?.zh || recipe?.display?.en || slug
          const outfit = recipe?.outfits?.default?.label
          setCharacterNote(outfit ? `${name} · ${outfit}` : name)
          applyCharacter(recipe)
        } catch (err) {
          if (characterRequest.current !== request) return
          fail(messageOf(err))
        }
      })()
    },
    [applyCharacter],
  )

  const rollCharacter = useCallback(() => {
    const pool = characters.filter((item) => item.slug !== characterSlug)
    const source = pool.length > 0 ? pool : characters
    const pick = source[Math.floor(Math.random() * source.length)]
    if (pick) chooseCharacter(pick.slug)
  }, [characters, characterSlug, chooseCharacter])

  const rollPose = useCallback(() => {
    const pool = poses.filter((item) => item.id !== poseId)
    const source = pool.length > 0 ? pool : poses
    const pick = source[Math.floor(Math.random() * source.length)]
    if (!pick) return
    setPoseId(pick.id)
    applyPose(pick)
  }, [poses, poseId, applyPose])

  const choosePose = useCallback(
    (entry: PoseEntry) => {
      if (poseId === entry.id) {
        setPoseId('')
        applyPose(null)
        return
      }
      setPoseId(entry.id)
      applyPose(entry)
    },
    [applyPose, poseId],
  )

  const poseGroups = useMemo(() => {
    const map = new Map<string, PoseEntry[]>()
    for (const pose of poses) {
      const list = map.get(pose.poseName) ?? []
      list.push(pose)
      map.set(pose.poseName, list)
    }
    return [...map.entries()]
  }, [poses])
  const selectedPose = poses.find((pose) => pose.id === poseId) ?? null

  const submitRoll = useCallback(() => {
    const intent = composeIntent(sections, forms)
    const text = promptOf(intent)
    setPreviewOpen(true)
    setSaving(true)
    void (async () => {
      try {
        const saved = await api<{ id: string }>('dice/rolls', {
          method: 'POST',
          body: JSON.stringify({
            fields: intent,
            forms,
            prompt: text.positive,
            negative: text.negative,
            poseName: selectedPose?.poseName ?? null,
            poseId: selectedPose?.id ?? null,
          }),
        })
        notify(`已写入灵感记录 ${saved.id}`)
      } catch (err) {
        fail(messageOf(err))
      } finally {
        setSaving(false)
      }
    })()
  }, [sections, forms, selectedPose])

  const submitGenerate = useCallback(() => {
    if (!selectedPose) {
      fail('先选一个 pose，才能出图')
      return
    }
    const intent = composeIntent(sections, forms)
    const text = promptOf(intent)
    setPreviewOpen(true)
    setSaving(true)
    void (async () => {
      try {
        const saved = await api<{ id: string }>('dice/rolls', {
          method: 'POST',
          body: JSON.stringify({
            fields: intent,
            forms,
            prompt: text.positive,
            negative: text.negative,
            poseName: selectedPose.poseName,
            poseId: selectedPose.id,
          }),
        })
        const created = await api<{ taskId: string }>(`dice/rolls/${saved.id}/generate`, {
          method: 'POST',
        })
        const next = new URLSearchParams(searchParams.toString())
        next.set('tid', created.taskId)
        router.replace(`/dice?${next.toString()}`, { scroll: false })
        notify(`已提交生成 ${created.taskId}`)
      } catch (err) {
        fail(messageOf(err))
      } finally {
        setSaving(false)
      }
    })()
  }, [sections, forms, selectedPose, router, searchParams])

  const applyTemplate = useCallback(
    (template: DiceTemplate) => {
      characterRequest.current += 1
      const summary = characters.find((item) => item.slug === template.character)
      const pose = template.poseId
        ? poses.find((item) => item.id === template.poseId)
        : poses.find((item) => item.poseName === template.poseName)
      const next = formsFromStored(sections, template.forms) ?? formsFromIntent(sections, template.fields)
      formsRef.current = next
      setTemplateId(template.id)
      setCharacterSlug(template.character ?? '')
      setCharacterNote(summary?.display || template.character || '')
      setPoseId(pose?.id ?? '')
      setForms(next)
      setPreviewOpen(true)
    },
    [characters, poses, sections],
  )

  const openTemplateDialog = useCallback(() => {
    const current = templates.find((item) => item.id === templateId)
    setPickedId(current?.id ?? '')
    setTemplateDraft(current?.name ?? '')
    setTemplateOpen(true)
  }, [templates, templateId])

  const pickTemplate = useCallback((template: DiceTemplate) => {
    setPickedId(template.id)
    setTemplateDraft(template.name)
  }, [])

  const templatePayload = useCallback(() => {
    const intent = composeIntent(sections, forms)
    setPreviewOpen(true)
    return {
      character: characterSlug || null,
      poseName: selectedPose?.poseName ?? null,
      poseId: selectedPose?.id ?? null,
      fields: intent,
      forms,
    }
  }, [sections, forms, characterSlug, selectedPose])

  const createTemplate = useCallback(() => {
    const name = templateDraft.trim()
    if (name === '') {
      fail('先写模版名')
      return
    }
    const payload = templatePayload()
    void (async () => {
      try {
        const saved = await api<{ template: DiceTemplate }>('dice/templates', {
          method: 'POST',
          body: JSON.stringify({ name, ...payload }),
        })
        setTemplates((cur) => [saved.template, ...cur.filter((item) => item.id !== saved.template.id)])
        setPickedId(saved.template.id)
        setTemplateId(saved.template.id)
        setTemplateDraft(saved.template.name)
        notify(`已新建模版 ${saved.template.name}`)
      } catch (err) {
        fail(messageOf(err))
      }
    })()
  }, [templateDraft, templatePayload])

  const renameTemplate = useCallback(() => {
    const name = templateDraft.trim()
    if (pickedId === '' || name === '') {
      fail('先选中模版并写上新名字')
      return
    }
    void (async () => {
      try {
        const saved = await api<{ template: DiceTemplate }>(`dice/templates/${pickedId}`, {
          method: 'PATCH',
          body: JSON.stringify({ name }),
        })
        setTemplates((cur) => cur.map((item) => (item.id === saved.template.id ? saved.template : item)))
        setTemplateDraft(saved.template.name)
        notify(`已改名为 ${saved.template.name}`)
      } catch (err) {
        fail(messageOf(err))
      }
    })()
  }, [templateDraft, pickedId])

  const deleteTemplate = useCallback(() => {
    if (pickedId === '') return
    const id = pickedId
    void (async () => {
      try {
        await api(`dice/templates/${id}`, { method: 'DELETE' })
        setTemplates((cur) => cur.filter((item) => item.id !== id))
        setPickedId('')
        setTemplateDraft('')
        setTemplateId((cur) => (cur === id ? '' : cur))
        notify('已删除模版')
      } catch (err) {
        fail(messageOf(err))
      }
    })()
  }, [pickedId])

  const confirmTemplate = useCallback(() => {
    if (pickedId === '') {
      fail('先选一个模版')
      return
    }
    const payload = templatePayload()
    void (async () => {
      try {
        const saved = await api<{ template: DiceTemplate }>(`dice/templates/${pickedId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        })
        setTemplates((cur) => cur.map((item) => (item.id === saved.template.id ? saved.template : item)))
        setTemplateId(saved.template.id)
        setTemplateOpen(false)
        notify(`已保存到 ${saved.template.name}`)
      } catch (err) {
        fail(messageOf(err))
      }
    })()
  }, [pickedId, templatePayload])

  const setFormField = useCallback((name: string, key: FormKey, value: string) => {
    setForms((cur) => ({
      ...cur,
      [name]: { ...(cur[name] ?? emptyForm()), [key]: value },
    }))
  }, [])

  const fillTag = useCallback(
    (name: string, tag: string) => {
      setForms((cur) => {
        const form = cur[name] ?? emptyForm()
        const ordered = orderOf.get(name) ?? []
        const taken = new Set([
          ...selectedTags(form.character, ordered),
          ...selectedTags(form.pose, ordered),
          ...selectedTags(form.reference, ordered),
        ])
        if (taken.has(tag)) return cur
        const selected = selectedTags(form.input, ordered).includes(tag)
        const next = selected ? removeTag(form.input, tag, ordered) : appendTag(form.input, tag, ordered)
        if (next === form.input) return cur
        return { ...cur, [name]: { ...form, input: next } }
      })
    },
    [orderOf],
  )

  const rollGroupTag = useCallback(
    (name: string, tags: string[]) => {
      setForms((cur) => {
        const form = cur[name] ?? emptyForm()
        const ordered = orderOf.get(name) ?? []
        const blocked = new Set([
          ...selectedTags(form.character, ordered),
          ...selectedTags(form.pose, ordered),
          ...selectedTags(form.reference, ordered),
          ...selectedTags(form.input, ordered),
        ])
        const pool = tags.filter((tag) => !blocked.has(tag))
        const pick = pool[Math.floor(Math.random() * pool.length)]
        if (!pick) return cur
        const next = appendTag(form.input, pick, ordered)
        if (next === form.input) return cur
        return { ...cur, [name]: { ...form, input: next } }
      })
    },
    [orderOf],
  )

  const loadRecommendations = useCallback((section: string, key: FormKey) => {
    const request = recRequest.current + 1
    recRequest.current = request
    const form = formsRef.current[section] ?? emptyForm()
    const ordered = orderOf.get(section) ?? []
    const own = tokensOf(form[key], ordered)
    const query = own.length > 0 ? own : mergeSlots(form, ordered)
    if (query.length === 0) {
      setRecommendations([])
      setRecStatus('先写入一些词，再看推荐')
      return
    }
    setRecStatus('推荐中…')
    void (async () => {
      try {
        const body = await api<{ recommendations: string[] }>('tag/recommend', {
          method: 'POST',
          body: JSON.stringify({ tags: query }),
        })
        if (recRequest.current !== request) return
        const present = new Set(mergeSlots(formsRef.current[section] ?? form, ordered).map(normTag))
        const next = body.recommendations.filter((tag) => !present.has(normTag(tag)))
        setRecommendations(next)
        setRecStatus(next.length === 0 ? '没有可推荐的词' : '')
      } catch (err) {
        if (recRequest.current !== request) return
        setRecommendations([])
        setRecStatus(messageOf(err))
      }
    })()
  }, [orderOf])

  const acceptRec = useCallback(
    (section: string, key: FormKey, tag: string) => {
      setRecommendations((list) => list.filter((item) => normTag(item) !== normTag(tag)))
      setForms((cur) => {
        const form = cur[section] ?? emptyForm()
        const next = appendTag(form[key], tag, orderOf.get(section) ?? [])
        if (next === form[key]) return cur
        return { ...cur, [section]: { ...form, [key]: next } }
      })
    },
    [orderOf],
  )

  const focusField = useCallback(
    (section: string, key: FormKey) => {
      window.clearTimeout(blurTimer.current)
      setFocus({ section, key })
      loadRecommendations(section, key)
    },
    [loadRecommendations],
  )

  const blurField = useCallback((section: string, key: FormKey) => {
    blurTimer.current = window.setTimeout(() => {
      setFocus((cur) => (cur?.section === section && cur.key === key ? null : cur))
    }, 180)
  }, [])

  const previewIntent = useMemo(() => composeIntent(sections, forms), [sections, forms])
  const previewText = useMemo(() => promptOf(previewIntent), [previewIntent])
  const previewActive = Object.values(forms).some(
    (form) => form.character !== '' || form.pose !== '' || form.reference !== '' || form.input !== '',
  )
  const showPreview = previewOpen || previewActive
  const copyText = (text: string) => {
    void navigator.clipboard.writeText(text)
  }

  return (
    <div className="dice-page">
      <section className="panel">
        <div className="column-head">
          <h2>角色造型</h2>
          <span className="muted">先选模版，或先选角色再选 pose</span>
        </div>
        <div className="column-head">
          <h2>模版</h2>
          <span className="muted">
            {templates.find((item) => item.id === templateId)?.name ?? '未选择'}
          </span>
        </div>
        {templates.length === 0 ? <p className="muted">还没有模版</p> : null}
        <div className="dice-tags dice-template-list">
          {templates.map((template) => {
            const on = template.id === templateId
            return (
              <button
                key={template.id}
                type="button"
                className={`dice-tag ${on ? 'on' : ''}`}
                aria-pressed={on}
                onClick={() => applyTemplate(template)}
              >
                {template.name}
              </button>
            )
          })}
        </div>
        <div className="column-head">
          <div className="dice-head-title">
            <h2>角色</h2>
            <button
              type="button"
              className="dice-roll"
              aria-label="随机角色"
              disabled={characters.length === 0}
              onClick={rollCharacter}
            >
              🎲
            </button>
          </div>
          <span className="muted">{characterNote !== '' ? characterNote : '未选择'}</span>
        </div>
        {characterSlug !== '' ? (
          <div className="dice-pose-tools">
            <button
              type="button"
              className="quiet"
              onClick={() => chooseCharacter('')}
            >
              清除角色
            </button>
          </div>
        ) : null}
        {characters.length === 0 && poseError === '' ? <p className="muted">加载中…</p> : null}
        <div className="dice-pose-grid dice-character-grid">
          {characters.map((character) => {
            const on = character.slug === characterSlug
            const url = assetUrl('character-file', character.preview)
            const name = character.display || character.slug
            return (
              <button
                key={character.slug}
                type="button"
                className={`dice-pose-item dice-character-item ${on ? 'on' : ''}`}
                onClick={() => chooseCharacter(on ? '' : character.slug)}
                title={name}
                aria-pressed={on}
                aria-label={name}
              >
                {url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={url} alt={name} />
                ) : (
                  <span className="muted">无图</span>
                )}
                <span className="dice-character-name">{name}</span>
                <span className="dice-pose-check" aria-hidden={true}>
                  {on ? '✓' : ''}
                </span>
              </button>
            )
          })}
        </div>
        <div className="column-head">
          <div className="dice-head-title">
            <h2>pose</h2>
            <button
              type="button"
              className="dice-roll"
              aria-label="随机 pose"
              disabled={poses.length === 0}
              onClick={rollPose}
            >
              🎲
            </button>
          </div>
          <span className="muted">
            {selectedPose ? `${selectedPose.poseName} · ${selectedPose.id}` : '未选择'}
            {poses.length > 0 ? ` · ${poses.length}` : ''}
          </span>
        </div>
        {poseId !== '' ? (
          <div className="dice-pose-tools">
            <button
              type="button"
              className="quiet"
              onClick={() => {
                setPoseId('')
                applyPose(null)
              }}
            >
              清除 pose
            </button>
          </div>
        ) : null}
        {poseError !== '' ? <p className="muted">{poseError}</p> : null}
        {poses.length === 0 && poseError === '' ? <p className="muted">加载中…</p> : null}
        <div className="dice-pose-groups">
          {poseGroups.map(([poseName, entries]) => (
            <PoseGroup
              key={poseName}
              poseName={poseName}
              entries={entries}
              poseId={poseId}
              onChoose={choosePose}
            />
          ))}
        </div>
      </section>

      {sections.map((section) => {
        const form = forms[section.name] ?? emptyForm()
        const ordered = orderOf.get(section.name) ?? []
        const filled = new Set(selectedTags(form.input, ordered))
        const locked = new Set([
          ...selectedTags(form.character, ordered),
          ...selectedTags(form.pose, ordered),
          ...selectedTags(form.reference, ordered),
        ])
        return (
          <section className="panel" key={section.name}>
            <div className="column-head">
              <h2>{section.name}</h2>
            </div>
            <div className="dice-form-fields">
              {FORM_KEYS.map((key) => (
                <label key={key}>
                  <span className="dice-card-title">{FIELD_LABEL[key]}</span>
                  {key === 'input' ? (
                    <textarea
                      rows={3}
                      value={form.input}
                      spellCheck={false}
                      aria-label={`${section.name} input`}
                      onChange={(event) => setFormField(section.name, key, event.target.value)}
                      onFocus={() => focusField(section.name, key)}
                      onBlur={() => blurField(section.name, key)}
                    />
                  ) : (
                    <input
                      value={form[key]}
                      spellCheck={false}
                      aria-label={`${section.name} ${key}`}
                      onChange={(event) => setFormField(section.name, key, event.target.value)}
                      onFocus={() => focusField(section.name, key)}
                      onBlur={() => blurField(section.name, key)}
                    />
                  )}
                  {focus?.section === section.name && focus.key === key ? (
                    <div className="dice-recs">
                      {recStatus !== '' ? <p className="muted dice-pose-hint">{recStatus}</p> : null}
                      {recommendations.length > 0 ? (
                        <div className="dice-tags">
                          {recommendations.map((tag) => (
                            <button
                              key={tag}
                              type="button"
                              className="dice-tag dice-rec"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => acceptRec(section.name, key, tag)}
                            >
                              {tag}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </label>
              ))}
            </div>
            {section.groups.map((group) => (
              <div className="dice-tag-group" key={group.name || section.name}>
                <div className="dice-group-head">
                  {group.name !== '' ? <div className="dice-group-label">{group.name}</div> : null}
                  <button
                    type="button"
                    className="dice-roll"
                    aria-label={`随机 ${section.name}${group.name !== '' ? ` ${group.name}` : ''}`}
                    disabled={!group.tags.some((tag) => !locked.has(tag) && !filled.has(tag))}
                    onClick={() => rollGroupTag(section.name, group.tags)}
                  >
                    🎲
                  </button>
                </div>
                <div className="dice-tags">
                  {group.tags.map((tag) => {
                    const blocked = locked.has(tag)
                    return (
                      <button
                        key={tag}
                        type="button"
                        className={`dice-tag ${blocked ? 'locked' : filled.has(tag) ? 'on' : ''}`}
                        aria-pressed={filled.has(tag)}
                        aria-disabled={blocked}
                        disabled={blocked}
                        onClick={() => fillTag(section.name, tag)}
                      >
                        {tag}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </section>
        )
      })}

      <section className="panel">
        <div className="column-head">
          <h2>结构化 prompt</h2>
          <div className="dice-prompt-switch" role="group" aria-label="prompt 预览">
            <button
              type="button"
              className={`dice-tag ${promptView === 'joined' ? 'on' : ''}`}
              aria-pressed={promptView === 'joined'}
              onClick={() => setPromptView('joined')}
            >
              拼合
            </button>
            <button
              type="button"
              className={`dice-tag ${promptView === 'fields' ? 'on' : ''}`}
              aria-pressed={promptView === 'fields'}
              onClick={() => setPromptView('fields')}
            >
              结构化
            </button>
          </div>
        </div>
        <p className="muted dice-pose-hint">
          {promptView === 'joined'
            ? '角色、pose、input 合成后，按提交时写入的正向和负面摊开'
            : '角色、pose、input 按这个顺序合成'}
        </p>
        <div className="dice-pose-tools">
          <button type="button" onClick={() => setPreviewOpen(true)}>
            生成
          </button>
          <button type="button" className="quiet" disabled={saving} onClick={submitRoll}>
            {saving ? '提交中…' : '提交'}
          </button>
          <button type="button" disabled={saving || selectedPose === null} onClick={submitGenerate}>
            {saving ? '提交中…' : '提交生成'}
          </button>
          <button type="button" className="quiet" onClick={openTemplateDialog}>
            保存到模版
          </button>
        </div>
        {taskId !== '' ? <TaskDetail id={taskId} embedded /> : null}
        <Dialog open={templateOpen} title="保存到模版" onClose={() => setTemplateOpen(false)}>
          <div className="dice-template-dialog">
            <p className="muted">选一个模版后确认，当前结构化 prompt、角色和 pose 会写进这条模版。</p>
            {templates.length === 0 ? <p className="muted">还没有模版，先在下面新建。</p> : null}
            <div className="dice-tags dice-template-list">
              {templates.map((template) => {
                const on = template.id === pickedId
                return (
                  <button
                    key={template.id}
                    type="button"
                    className={`dice-tag ${on ? 'on' : ''}`}
                    aria-pressed={on}
                    onClick={() => pickTemplate(template)}
                  >
                    {template.name}
                  </button>
                )
              })}
            </div>
            <div className="dice-template-edit">
              <input
                value={templateDraft}
                spellCheck={false}
                aria-label="模版名"
                placeholder="模版名"
                onChange={(event) => setTemplateDraft(event.target.value)}
              />
              <button type="button" onClick={createTemplate}>
                新建模版
              </button>
              <button type="button" className="quiet" disabled={pickedId === ''} onClick={renameTemplate}>
                改名
              </button>
              <button type="button" className="quiet" disabled={pickedId === ''} onClick={deleteTemplate}>
                删除
              </button>
            </div>
            <div className="dice-pose-tools">
              <button type="button" disabled={pickedId === ''} onClick={confirmTemplate}>
                确认
              </button>
              <button type="button" className="quiet" onClick={() => setTemplateOpen(false)}>
                取消
              </button>
            </div>
          </div>
        </Dialog>
        {showPreview ? (
          <div className="dice-generated">
            {promptView === 'joined' ? (
              <>
                <div className="dice-roll-detail-block">
                  <div className="dice-roll-detail-label">
                    <span className="muted">正向</span>
                    <button type="button" className="quiet" onClick={() => copyText(previewText.positive)}>
                      复制
                    </button>
                  </div>
                  <p className="mono dice-roll-detail-prompt">
                    {previewText.positive !== '' ? previewText.positive : '（空）'}
                  </p>
                </div>
                <div className="dice-roll-detail-block">
                  <div className="dice-roll-detail-label">
                    <span className="muted">负面</span>
                    <button type="button" className="quiet" onClick={() => copyText(previewText.negative)}>
                      复制
                    </button>
                  </div>
                  <p className="mono dice-roll-detail-prompt">
                    {previewText.negative !== '' ? previewText.negative : '（空）'}
                  </p>
                </div>
              </>
            ) : (
              <pre className="dice-json">{JSON.stringify(previewIntent, null, 2)}</pre>
            )}
          </div>
        ) : null}
      </section>
    </div>
  )
}

function PoseGroup({
  poseName,
  entries,
  poseId,
  onChoose,
}: {
  poseName: string
  entries: PoseEntry[]
  poseId: string
  onChoose: (entry: PoseEntry) => void
}) {
  const selected = entries.some((pose) => pose.id === poseId)
  return (
    <details className="dice-pose-group">
      <summary>
        <span className="dice-pose-group-name">{poseName}</span>
        <span className="muted dice-pose-group-count">
          {selected ? '已选' : entries.length}
        </span>
      </summary>
      <div className="dice-pose-grid">
        {entries.map((pose) => {
          const on = pose.id === poseId
          const url = depthUrl(pose)
          return (
            <button
              key={pose.id}
              type="button"
              className={`dice-pose-item ${on ? 'on' : ''}`}
              onClick={() => onChoose(pose)}
              title={`${pose.poseName} · ${pose.id}`}
              aria-pressed={on}
            >
              {url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={url} alt={`${pose.poseName} ${pose.id}`} loading="lazy" />
              ) : (
                <span className="muted">无图</span>
              )}
              <span className="dice-pose-check" aria-hidden={true}>
                {on ? '✓' : ''}
              </span>
            </button>
          )
        })}
      </div>
    </details>
  )
}
