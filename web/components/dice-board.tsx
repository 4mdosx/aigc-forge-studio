'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api } from '@/lib/api'
import { initialIntent, type CreativeIntent } from '@/lib/intent'
import { fail, messageOf, notify } from '@/lib/notify'

// 造型页：顶部先选角色再选 pose，分别写入各字段的 character / pose。
// 卡片输入顺序与选择顺序一致：角色、pose、input。
// role.json 的词只作快速输入；已经由角色或 pose 写入的词在候选里不可再选。
// 生成按角色、pose、input 合成 CreativeIntent。

const FORM_KEYS = ['character', 'pose', 'input'] as const

type FormKey = (typeof FORM_KEYS)[number]

const FIELD_LABEL: Record<FormKey, string> = {
  character: '角色',
  pose: 'pose',
  input: 'input',
}

interface FieldForm {
  pose: string
  character: string
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
  return { pose: '', character: '', input: '' }
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

function joinTags(tags: string[]): string {
  return tags.join(',')
}

function splitTags(value: string): string[] {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '')
}

function mergeSlots(form: FieldForm): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of [form.character, form.pose, form.input]) {
    for (const tag of splitTags(part)) {
      const key = normTag(tag)
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      out.push(tag)
    }
  }
  return out
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
    const tags = mergeSlots(forms[section.name] ?? emptyForm())
    if (Array.isArray(record[field])) record[field] = tags
    else record[field] = tags.join(',')
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
  const sections = useMemo(() => sectionsOf(role), [role])
  const sectionNames = useMemo(() => sections.map((section) => section.name), [sections])
  const [forms, setForms] = useState<Record<string, FieldForm>>(() => formsOf(sections))
  const [characters, setCharacters] = useState<CharacterSummary[]>([])
  const [characterSlug, setCharacterSlug] = useState('')
  const [characterNote, setCharacterNote] = useState('')
  const [poses, setPoses] = useState<PoseEntry[]>([])
  const [poseId, setPoseId] = useState('')
  const [poseError, setPoseError] = useState('')
  const [generated, setGenerated] = useState<CreativeIntent | null>(null)
  const [saving, setSaving] = useState(false)
  const [focus, setFocus] = useState<{ section: string; key: FormKey } | null>(null)
  const [recommendations, setRecommendations] = useState<string[]>([])
  const [recStatus, setRecStatus] = useState('')
  const characterRequest = useRef(0)
  const recRequest = useRef(0)
  const blurTimer = useRef<number | undefined>(undefined)
  const formsRef = useRef(forms)
  formsRef.current = forms

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
        const [poseBody, characterBody] = await Promise.all([
          api<{ poses: PoseEntry[] }>('data/poses?enabled=true'),
          api<{ characters: CharacterSummary[] }>('data/characters'),
        ])
        if (cancelled) return
        setPoses(poseBody.poses)
        setCharacters(characterBody.characters)
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
      setGenerated(null)
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
    setGenerated(null)
    setPoseId(pick.id)
    applyPose(pick)
  }, [poses, poseId, applyPose])

  const choosePose = useCallback(
    (entry: PoseEntry) => {
      setGenerated(null)
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
    setGenerated(intent)
    setSaving(true)
    void (async () => {
      try {
        const saved = await api<{ id: string }>('dice/rolls', {
          method: 'POST',
          body: JSON.stringify({
            fields: intent,
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

  const setFormField = useCallback((name: string, key: FormKey, value: string) => {
    setGenerated(null)
    setForms((cur) => ({
      ...cur,
      [name]: { ...(cur[name] ?? emptyForm()), [key]: value },
    }))
  }, [])

  const fillTag = useCallback(
    (name: string, tag: string) => {
      setGenerated(null)
      setForms((cur) => {
        const form = cur[name] ?? emptyForm()
        const ordered = orderOf.get(name) ?? []
        const taken = new Set([
          ...selectedTags(form.character, ordered),
          ...selectedTags(form.pose, ordered),
        ])
        if (taken.has(tag)) return cur
        const next = appendTag(form.input, tag, ordered)
        if (next === form.input) return cur
        return { ...cur, [name]: { ...form, input: next } }
      })
    },
    [orderOf],
  )

  const rollGroupTag = useCallback(
    (name: string, tags: string[]) => {
      setGenerated(null)
      setForms((cur) => {
        const form = cur[name] ?? emptyForm()
        const ordered = orderOf.get(name) ?? []
        const blocked = new Set([
          ...selectedTags(form.character, ordered),
          ...selectedTags(form.pose, ordered),
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
    const own = splitTags(form[key])
    const query = own.length > 0 ? own : mergeSlots(form)
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
        const present = new Set(mergeSlots(formsRef.current[section] ?? form).map(normTag))
        const next = body.recommendations.filter((tag) => !present.has(normTag(tag)))
        setRecommendations(next)
        setRecStatus(next.length === 0 ? '没有可推荐的词' : '')
      } catch (err) {
        if (recRequest.current !== request) return
        setRecommendations([])
        setRecStatus(messageOf(err))
      }
    })()
  }, [])

  const acceptRec = useCallback(
    (section: string, key: FormKey, tag: string) => {
      setGenerated(null)
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

  const prompt = generated ? promptOf(generated) : null

  return (
    <div className="dice-page">
      <section className="panel">
        <div className="column-head">
          <h2>角色造型</h2>
          <span className="muted">先选角色，再选 pose</span>
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
                setGenerated(null)
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
          <span className="muted">角色、pose、input 按这个顺序合成</span>
        </div>
        <div className="dice-pose-tools">
          <button
            type="button"
            onClick={() => setGenerated(composeIntent(sections, forms))}
          >
            生成
          </button>
          <button type="button" className="quiet" disabled={saving} onClick={submitRoll}>
            {saving ? '提交中…' : '提交'}
          </button>
        </div>
        {generated && prompt ? (
          <div className="dice-generated">
            <p className="dice-prompt-line">
              <span className="dice-card-title">positive </span>
              {prompt.positive || '（空）'}
            </p>
            <p className="dice-prompt-line">
              <span className="dice-card-title">negative </span>
              {prompt.negative || '（空）'}
            </p>
            <pre className="dice-json">{JSON.stringify(generated, null, 2)}</pre>
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
