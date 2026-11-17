'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api } from '@/lib/api'
import { fail, messageOf } from '@/lib/notify'

// 🎲 掷骰工作台：字段池存 runner SQLite（dice_fields.tiers JSON）。
// 每字段分层：common（手动公共池）+ general/sensitive/questionable/explicit（tag 分类导入）；
// 顶部勾选参与掷骰的层级；每层独立「摇几个」，行内显示该层池子总数。
// 导出 = 配置 JSON 下载；导入 = 配置回填 或 tag_classify 输出（buckets → 层）。
// 配置改动静默防抖 PUT 全量保存；「重置为默认」走 POST /dice/reset。
// pose 池：data/pose/<动作>/<id>/depth.png 经 manifest 列出，按动作分组勾选；
// 「一起生成」从勾选池随机挑一张，动作 tag 注入拼合 prompt。选择存 localStorage。

type Tier = 'common' | 'general' | 'sensitive' | 'questionable' | 'explicit'

const TIERS: Tier[] = ['common', 'general', 'sensitive', 'questionable', 'explicit']

const TIER_LABEL: Record<Tier, string> = {
  common: 'common',
  general: 'general',
  sensitive: 'sensitive',
  questionable: 'questionable',
  explicit: 'explicit',
}

interface TierConfig {
  values: string
  min: number
  max: number
}

interface DiceField {
  name: string
  tiers: Partial<Record<Tier, TierConfig>>
}

interface LoadedField extends DiceField {
  picked: Partial<Record<Tier, string[]>>
}

const DEFAULT_RATINGS: Record<Tier, boolean> = {
  common: true,
  general: true,
  sensitive: false,
  questionable: false,
  explicit: false,
}

const RATINGS_STORAGE_KEY = 'dice-ratings-v1'
const POSES_STORAGE_KEY = 'dice-poses-v1'

interface PoseEntry {
  id: string
  poseName: string
  name?: string
  tags?: string[]
  guide?: { view?: string[]; shot?: string[]; framing?: string[] }
  variants?: Record<string, { depth?: string }>
}

// manifest depth 路径形如 pose/<动作>/<id>/depth.png（相对 data 根），原样透传给 pose-file 端点
// （端点要求路径必须以 pose/ 开头，这里不做剥前缀——剥了就 400）
function depthUrl(entry: PoseEntry): string | null {
  for (const variant of Object.values(entry.variants ?? {})) {
    const depth = variant?.depth
    if (depth) {
      return `/api/runner/data/pose-file/${depth
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`
    }
  }
  return null
}

// pose 注入 prompt 的词：meta tags + guide.shot（如 kneeling + full body）
function poseTagsOf(entry: PoseEntry): string[] {
  return [...new Set([...(entry.tags ?? []), ...(entry.guide?.shot ?? [])])]
}

function wordsOf(values: string): string[] {
  return [...new Set(values.split(/[,;\n]/).map((w) => w.trim()).filter((w) => w !== ''))]
}

// 区间内随机取 n，再部分洗牌取前 n 个
function pickWords(values: string, min: number, max: number): string[] {
  const words = wordsOf(values)
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  const span = hi - lo + 1
  const n = Math.max(0, Math.min(lo + Math.floor(Math.random() * span), words.length))
  for (let i = 0; i < n; i += 1) {
    const j = i + Math.floor(Math.random() * (words.length - i))
    ;[words[i], words[j]] = [words[j], words[i]]
  }
  return words.slice(0, n)
}

const tierOf = (field: LoadedField, tier: Tier): TierConfig =>
  field.tiers[tier] ?? { values: '', min: 1, max: 1 }

// 旧版单值 count → min=max=count；区间不合法时收拢
function normalizeTiers(raw: unknown): Partial<Record<Tier, TierConfig>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Partial<Record<Tier, TierConfig>> = {}
  for (const [tier, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!TIERS.includes(tier as Tier)) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const t = value as Record<string, unknown>
    const clamp = (n: number) =>
      Number.isInteger(n) && n >= 0 ? Math.min(n, 99) : 1
    let min = clamp(Number(t.min ?? t.count ?? 1))
    let max = clamp(Number(t.max ?? t.count ?? 1))
    if (max < min) max = min
    out[tier as Tier] = {
      values: typeof t.values === 'string' ? t.values : '',
      min,
      max,
    }
  }
  return out
}

function asLoaded(rows: Array<{ name: string; tiers?: unknown }>): LoadedField[] {
  return rows.map((row) => ({ name: row.name, tiers: normalizeTiers(row.tiers), picked: {} }))
}

// 移动端媒体查询（SSR 首帧 false，首屏数据拉取后 effect 已跑，无闪烁风险）
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export function DiceBoard() {
  const [fields, setFields] = useState<LoadedField[]>([])
  const [loaded, setLoaded] = useState(false)
  const [rolled, setRolled] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [enabled, setEnabled] = useState<Record<Tier, boolean>>(DEFAULT_RATINGS)
  const [importMsg, setImportMsg] = useState('')
  const [poses, setPoses] = useState<PoseEntry[]>([])
  const [poseSel, setPoseSel] = useState<Set<string>>(new Set())
  const [posePick, setPosePick] = useState<PoseEntry | null>(null)
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const isMobile = useMediaQuery('(max-width: 759px)')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const togglePose = useCallback((id: string) => {
    setPoseSel((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(POSES_STORAGE_KEY, JSON.stringify([...next]))
      } catch {
        // 存不了就算了
      }
      return next
    })
  }, [])

  const setAllPoses = useCallback((entries: PoseEntry[], on: boolean) => {
    setPoseSel(() => {
      const next = new Set(on ? entries.map((p) => p.id) : [])
      try {
        localStorage.setItem(POSES_STORAGE_KEY, JSON.stringify([...next]))
      } catch {
        // 忽略
      }
      return next
    })
  }, [])

  const save = useCallback(async (list: LoadedField[]) => {
    setSaveState('saving')
    try {
      await api('dice/fields', {
        method: 'PUT',
        body: JSON.stringify({
          fields: list.map((f) => ({ name: f.name, tiers: f.tiers })),
        }),
      })
      setSaveState('saved')
    } catch (err) {
      setSaveState('error')
      fail(messageOf(err))
    }
  }, [])

  const scheduleSave = useCallback(
    (list: LoadedField[]) => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => void save(list), 600)
    },
    [save],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const body = await api<{ fields: Array<{ name: string; tiers?: unknown }> }>('dice/fields')
        if (cancelled) return
        setFields(asLoaded(body.fields))
      } catch (err) {
        fail(messageOf(err))
      }
      if (!cancelled) setLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // pose 池：manifest 只读列出；首次进入默认全选，之后以 localStorage 存档为准
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const body = await api<{ poses: PoseEntry[] }>('data/poses?enabled=true')
        if (cancelled) return
        setPoses(body.poses)
        let saved: string[] | null = null
        try {
          const raw = localStorage.getItem(POSES_STORAGE_KEY)
          if (raw) saved = JSON.parse(raw) as string[]
        } catch {
          // 无存档
        }
        setPoseSel(new Set(saved ?? body.poses.map((p) => p.id)))
      } catch (err) {
        fail(messageOf(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // rating 勾选是 UI 偏好，存浏览器本地（导出文件里也带一份）
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RATINGS_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        setEnabled((cur) => {
          const next = { ...cur }
          for (const tier of TIERS) {
            if (typeof parsed[tier] === 'boolean') next[tier] = parsed[tier] as boolean
          }
          return next
        })
      }
    } catch {
      // 无存档就用默认勾选
    }
  }, [])

  const toggleRating = useCallback((tier: Tier) => {
    setEnabled((cur) => {
      const next = { ...cur, [tier]: !cur[tier] }
      try {
        localStorage.setItem(RATINGS_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // 存不了就算了
      }
      return next
    })
  }, [])

  // patch 带 picked = 掷骰结果，不触发保存；其他 = 配置变更，防抖落库
  const updateField = useCallback(
    (index: number, patch: Partial<LoadedField>) => {
      setFields((cur) => {
        const next = cur.map((f, i) => (i === index ? { ...f, ...patch } : f))
        if (!('picked' in patch)) scheduleSave(next)
        return next
      })
    },
    [scheduleSave],
  )

  const updateTier = useCallback(
    (index: number, tier: Tier, patch: Partial<TierConfig>) => {
      setFields((cur) => {
        const next = cur.map((f, i) => {
          if (i !== index) return f
          return {
            ...f,
            tiers: { ...f.tiers, [tier]: { ...tierOf(f, tier), ...patch } },
          }
        })
        scheduleSave(next)
        return next
      })
    },
    [scheduleSave],
  )

  const rollField = useCallback(
    (index: number) => {
      setFields((cur) =>
        cur.map((f, i) => {
          if (i !== index) return f
          const picked: Partial<Record<Tier, string[]>> = {}
          for (const tier of TIERS) {
            if (!enabled[tier]) continue
            const cfg = tierOf(f, tier)
            const words = pickWords(cfg.values, cfg.min, cfg.max)
            if (words.length > 0) picked[tier] = words
          }
          return { ...f, picked }
        }),
      )
      setRolled(true)
    },
    [enabled],
  )

  const rollAll = useCallback(() => {
    setFields((cur) =>
      cur.map((f) => {
        const picked: Partial<Record<Tier, string[]>> = {}
        for (const tier of TIERS) {
          if (!enabled[tier]) continue
          const cfg = tierOf(f, tier)
          const words = pickWords(cfg.values, cfg.min, cfg.max)
          if (words.length > 0) picked[tier] = words
        }
        return { ...f, picked }
      }),
    )
    const pool = poses.filter((p) => poseSel.has(p.id))
    setPosePick(pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : null)
    setRolled(true)
  }, [enabled, poses, poseSel])

  const addField = useCallback(() => {
    setFields((cur) => {
      let name = 'custom.field'
      for (let n = 2; cur.some((f) => f.name === name); n += 1) {
        name = `custom.field${n}`
      }
      const next = [...cur, { name, tiers: {}, picked: {} }]
      scheduleSave(next)
      return next
    })
  }, [scheduleSave])

  const removeField = useCallback(
    (index: number) => {
      setFields((cur) => {
        const next = cur.filter((_, i) => i !== index)
        scheduleSave(next)
        return next
      })
    },
    [scheduleSave],
  )

  const resetToSeed = useCallback(() => {
    void (async () => {
      try {
        await api('dice/reset', { method: 'POST' })
        const body = await api<{ fields: Array<{ name: string; tiers?: unknown }> }>('dice/fields')
        setFields(asLoaded(body.fields))
        setRolled(false)
        setSaveState('saved')
      } catch (err) {
        fail(messageOf(err))
      }
    })()
  }, [])

  // ---- 导入导出 ----

  const exportConfig = useCallback(() => {
    const payload = {
      version: 1,
      kind: 'dice-config',
      enabled,
      fields: fields.map(({ name, tiers }) => ({ name, tiers })),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'dice-config.json'
    a.click()
    URL.revokeObjectURL(url)
  }, [enabled, fields])

  const importFile = useCallback(
    (file: File) => {
      void (async () => {
        let obj: unknown
        try {
          obj = JSON.parse(await file.text())
        } catch {
          fail('导入失败：不是合法 JSON')
          return
        }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
          fail('导入失败：JSON 结构不对')
          return
        }
        const body = obj as Record<string, unknown>

        // tag_classify 输出：buckets.<rating>.<field> = tags[] → 灌进对应层级词池
        if (body.buckets && typeof body.buckets === 'object' && !Array.isArray(body.buckets)) {
          const next = fields.map((f) => ({ ...f, tiers: { ...f.tiers }, picked: {} }))
          let touched = 0
          for (const [bucket, fieldMap] of Object.entries(
            body.buckets as Record<string, unknown>,
          )) {
            if (bucket === 'common' || bucket === 'unknown') continue
            if (!TIERS.includes(bucket as Tier)) continue
            if (!fieldMap || typeof fieldMap !== 'object' || Array.isArray(fieldMap)) continue
            for (const [fieldName, tags] of Object.entries(
              fieldMap as Record<string, unknown>,
            )) {
              if (!Array.isArray(tags)) continue
              const words = tags.filter((t): t is string => typeof t === 'string')
              if (words.length === 0) continue
              let field = next.find((f) => f.name === fieldName)
              if (!field) {
                field = { name: fieldName, tiers: {}, picked: {} }
                next.push(field)
              }
              const existing = field.tiers[bucket as Tier]
              field.tiers[bucket as Tier] = {
                values: words.join(', '),
                min: existing?.min ?? 1,
                max: existing?.max ?? 1,
              }
              touched += 1
            }
          }
          setFields(next)
          scheduleSave(next)
          setImportMsg(`已导入 tag 分类：灌了 ${touched} 个字段层（数量保持原值，自行调整）`)
          setRolled(false)
          return
        }

        // 配置回填：fields + 可选 enabled
        if (Array.isArray(body.fields)) {
          const restored = asLoaded(
            (body.fields as Array<Record<string, unknown>>).map((f) => {
              // 旧版单层配置（values/count）→ common 层
              if (typeof f.values === 'string' || f.count !== undefined) {
                const count = Number(f.count ?? f.max ?? 1)
                return {
                  name: String(f.name ?? ''),
                  tiers: {
                    common: {
                      values: typeof f.values === 'string' ? f.values : '',
                      min: Number.isInteger(count) && count >= 0 ? count : 1,
                      max: Number.isInteger(count) && count >= 0 ? count : 1,
                    },
                  },
                }
              }
              return { name: String(f.name ?? ''), tiers: f.tiers }
            }),
          )
          if (body.enabled && typeof body.enabled === 'object' && !Array.isArray(body.enabled)) {
            const incoming = body.enabled as Record<string, unknown>
            setEnabled((cur) => {
              const next = { ...cur }
              for (const tier of TIERS) {
                if (typeof incoming[tier] === 'boolean') next[tier] = incoming[tier] as boolean
              }
              try {
                localStorage.setItem(RATINGS_STORAGE_KEY, JSON.stringify(next))
              } catch {
                // 忽略
              }
              return next
            })
          }
          setFields(restored)
          scheduleSave(restored)
          setImportMsg(`已导入配置：${restored.length} 个字段`)
          setRolled(false)
          return
        }

        fail('导入失败：既不是 dice 配置也不是 tag 分类输出')
      })()
    },
    [fields, scheduleSave],
  )

  // 详情页打开时 Esc 返回
  useEffect(() => {
    if (openIndex === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenIndex(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openIndex])

  // ---- 结果合成 ----

  const composeOf = (field: LoadedField): string =>
    TIERS.filter((tier) => enabled[tier])
      .flatMap((tier) => field.picked[tier] ?? [])
      .join(', ')

  const poseTags = posePick ? poseTagsOf(posePick) : []
  const composed = Object.fromEntries(
    fields.map((f) => [f.name, composeOf(f)]).filter(([, v]) => v !== ''),
  )
  const negative = composed['constraints.exclude'] ?? null
  const poseResult = posePick
    ? { id: posePick.id, name: posePick.poseName, tags: poseTags }
    : null
  const joinedPrompt = [
    ...fields
      .filter((f) => f.name !== 'constraints.exclude')
      .map((f) => composeOf(f))
      .filter((v) => v !== ''),
    poseTags.join(', '),
  ]
    .filter((v) => v !== '')
    .join(', ')

  // pose 分组（动作名 → 条目），组内按 id 稳定排序
  const poseGroups = useMemo(() => {
    const map = new Map<string, PoseEntry[]>()
    for (const p of poses) {
      const list = map.get(p.poseName) ?? []
      list.push(p)
      map.set(p.poseName, list)
    }
    return [...map.entries()]
  }, [poses])
  const poseTotal = poses.length
  const poseSelCount = poses.reduce((n, p) => (poseSel.has(p.id) ? n + 1 : n), 0)

  function copyJson() {
    void navigator.clipboard.writeText(
      JSON.stringify({ ...composed, ...(poseResult ? { pose: poseResult } : {}) }, null, 2),
    )
  }

  return (
    <>
      <section className="panel">
        <div className="column-head">
          <h2>🎲 掷骰工作台</h2>
          <span className="muted">
            分层词池 · 每层独立数量 · 模版存 runner 数据库
            {saveState === 'saving'
              ? ' · 保存中…'
              : saveState === 'saved'
                ? ' · 已保存'
                : saveState === 'error'
                  ? ' · 保存失败'
                  : ''}
          </span>
        </div>
        <div className="dice-ratings">
          {TIERS.map((tier) => (
            <label key={tier} className={`dice-rating ${enabled[tier] ? 'on' : ''}`}>
              <input
                type="checkbox"
                checked={enabled[tier]}
                onChange={() => toggleRating(tier)}
              />
              {TIER_LABEL[tier]}
            </label>
          ))}
          <span className="muted dice-ratings-hint">勾选参与掷骰的层级</span>
        </div>
        <div className="dice-hero">
          <label className="quiet dice-file">
            导入
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) importFile(file)
                e.target.value = ''
              }}
            />
          </label>
          <button type="button" className="quiet" onClick={exportConfig}>
            导出
          </button>
          <button type="button" className="quiet" onClick={addField}>
            ＋ 加字段
          </button>
          <button type="button" className="quiet" onClick={resetToSeed}>
            重置为默认
          </button>
        </div>
        {importMsg !== '' ? <p className="muted dice-import-msg">{importMsg}</p> : null}
      </section>

      <section className="panel">
        {!loaded ? (
          <p className="muted">加载中…</p>
        ) : isMobile ? (
          <>
            <div className="dice-cards">
              {fields.map((field, index) => {
                const poolTotal = TIERS.filter((t) => enabled[t]).reduce(
                  (sum, t) => sum + wordsOf(tierOf(field, t).values).length,
                  0,
                )
                const takeTotal = TIERS.filter((t) => enabled[t]).reduce(
                  (sum, t) => sum + (wordsOf(tierOf(field, t).values).length > 0 ? tierOf(field, t).max : 0),
                  0,
                )
                const preview = TIERS.filter((t) => enabled[t])
                  .flatMap((t) => field.picked[t] ?? [])
                  .join(', ')
                return (
                  <div
                    key={field.name}
                    className="dice-card"
                    role="button"
                    tabIndex={0}
                    onClick={() => setOpenIndex(index)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.target === e.currentTarget) setOpenIndex(index)
                    }}
                  >
                    <div className="dice-card-main">
                      <div className="dice-card-name">{field.name}</div>
                      <div className="dice-card-sum muted">
                        池 {poolTotal} · 抽 ≤{takeTotal}
                      </div>
                      <div className={`dice-card-picked mono ${preview !== '' ? '' : 'muted'}`}>
                        {preview !== '' ? preview : '未掷骰'}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="dice-roll"
                      onClick={(e) => {
                        e.stopPropagation()
                        rollField(index)
                      }}
                      title="本字段掷骰"
                    >
                      🎲
                    </button>
                    <span className="dice-card-arrow" aria-hidden={true}>
                      ›
                    </span>
                  </div>
                )
              })}
            </div>
            {openIndex !== null && fields[openIndex] ? (
              <DiceFieldDetail
                field={fields[openIndex]}
                enabled={enabled}
                onRename={(patch) => updateField(openIndex, patch)}
                onTier={(tier, patch) => updateTier(openIndex, tier, patch)}
                onRoll={() => rollField(openIndex)}
                onRemove={() => {
                  removeField(openIndex)
                  setOpenIndex(null)
                }}
                onClose={() => setOpenIndex(null)}
              />
            ) : null}
          </>
        ) : (
          <div className="dice-grid">
            {fields.map((field, index) => {
              const poolTotal = TIERS.filter((t) => enabled[t]).reduce(
                (sum, t) => sum + wordsOf(tierOf(field, t).values).length,
                0,
              )
              const takeTotal = TIERS.filter((t) => enabled[t]).reduce(
                (sum, t) => sum + (wordsOf(tierOf(field, t).values).length > 0 ? tierOf(field, t).max : 0),
                0,
              )
              return (
                <div key={field.name} className="dice-field">
                  <div className="dice-head">
                    <input
                      className="dice-name"
                      value={field.name}
                      onChange={(e) => updateField(index, { name: e.target.value })}
                      aria-label="字段名"
                    />
                    <button
                      type="button"
                      className="quiet dice-remove"
                      onClick={() => removeField(index)}
                      title="删除字段"
                    >
                      ×
                    </button>
                  </div>
                  <div className="dice-tiers">
                    {TIERS.map((tier) => {
                      const cfg = tierOf(field, tier)
                      const pool = wordsOf(cfg.values).length
                      const picks = field.picked[tier] ?? []
                      return (
                        <div
                          key={tier}
                          className={`dice-tier ${enabled[tier] ? 'on' : 'off'}`}
                        >
                          <div className="dice-tier-row">
                            <span className={`dice-tier-label tier-${tier}`}>{tier}</span>
                            <label className="dice-count">
                              取
                              <input
                                type="number"
                                min={0}
                                max={cfg.max}
                                value={cfg.min}
                                onChange={(e) => {
                                  // min 最多到 max；max 跟着抬起，保持区间合法
                                  const min = Math.min(99, Math.max(0, Number(e.target.value) || 0))
                                  updateTier(index, tier, {
                                    min,
                                    max: Math.max(min, cfg.max),
                                  })
                                }}
                              />
                              –
                              <input
                                type="number"
                                min={cfg.min}
                                max={99}
                                value={cfg.max}
                                onChange={(e) => {
                                  // max 至少为 min；min 跟着压下
                                  const max = Math.min(99, Math.max(0, Number(e.target.value) || 0))
                                  updateTier(index, tier, {
                                    max,
                                    min: Math.min(max, cfg.min),
                                  })
                                }}
                              />
                              个
                            </label>
                            <span className="dice-pool">池 {pool}</span>
                          </div>
                          {picks.length > 0 ? (
                            <span className="dice-picked mono">{picks.join(', ')}</span>
                          ) : null}
                          <details className="dice-tier-edit">
                            <summary>词池</summary>
                            <textarea
                              rows={3}
                              value={cfg.values}
                              placeholder={`${tier} 层候选词，逗号分隔`}
                              onChange={(e) =>
                                updateTier(index, tier, { values: e.target.value })
                              }
                            />
                          </details>
                        </div>
                      )
                    })}
                  </div>
                  <div className="dice-foot">
                    <span className="muted">
                      抽取 {takeTotal} / 池 {poolTotal}
                    </span>
                    <button
                      type="button"
                      className="dice-roll"
                      onClick={() => rollField(index)}
                      title="本字段掷骰"
                    >
                      🎲
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="column-head">
          <h2>🧍 pose 池</h2>
          <span className="muted">
            按动作分组 · 点缩略图勾选 · 已选 {poseSelCount}/{poseTotal}
          </span>
        </div>
        <div className="dice-pose-tools">
          <button type="button" className="quiet" onClick={() => setAllPoses(poses, true)}>
            全选
          </button>
          <button type="button" className="quiet" onClick={() => setAllPoses(poses, false)}>
            清空
          </button>
          <span className="muted dice-pose-hint">「一起生成」时从勾选池随机挑一张</span>
        </div>
        <div className="dice-pose-groups">
          {poseGroups.map(([poseName, entries]) => (
            <PoseGroup
              key={poseName}
              poseName={poseName}
              entries={entries}
              poseSel={poseSel}
              onToggle={togglePose}
              onSetAll={(on) => setAllPoses(entries, on)}
            />
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="column-head">
          <h2>结果</h2>
          <span className="dice-result-actions">
            <button type="button" className="dice-hero-roll" onClick={rollAll}>
              🎲 一起生成
            </button>
            <button type="button" className="quiet" onClick={copyJson} disabled={!rolled}>
              复制 JSON
            </button>
          </span>
        </div>
        {posePick ? (
          <div className="dice-pose-result">
            {depthUrl(posePick) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="dice-pose-result-img"
                src={depthUrl(posePick) as string}
                alt={`pose ${posePick.poseName} ${posePick.id}`}
              />
            ) : null}
            <div className="dice-pose-result-meta">
              <strong>
                {posePick.poseName} · {posePick.id}
              </strong>
              {poseTags.length > 0 ? <span className="dice-picked mono">{poseTags.join(', ')}</span> : null}
            </div>
          </div>
        ) : null}
        <pre className="dice-json mono">
          {rolled ? JSON.stringify({ ...composed, ...(poseResult ? { pose: poseResult } : {}) }, null, 2) : '按 🎲 一起生成'}
        </pre>
        {joinedPrompt !== '' ? (
          <p className="dice-prompt mono">
            <span className="muted">拼合 prompt：</span>
            {joinedPrompt}
            {negative ? (
              <>
                {' '}
                <span className="muted">｜负面：</span>
                {negative}
              </>
            ) : null}
          </p>
        ) : null}
      </section>
    </>
  )
}

// 动作分组：折叠面板 + 组级三态勾选。缩略图网格只在展开时渲染（469 张不能全挂）。
function PoseGroup({
  poseName,
  entries,
  poseSel,
  onToggle,
  onSetAll,
}: {
  poseName: string
  entries: PoseEntry[]
  poseSel: Set<string>
  onToggle: (id: string) => void
  onSetAll: (on: boolean) => void
}) {
  const total = entries.length
  const sel = entries.reduce((n, p) => (poseSel.has(p.id) ? n + 1 : n), 0)
  const allOn = sel === total
  const checkRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (checkRef.current) checkRef.current.indeterminate = sel > 0 && sel < total
  }, [sel, total])
  return (
    <details className="dice-pose-group">
      <summary>
        <input
          ref={checkRef}
          type="checkbox"
          checked={allOn}
          onChange={() => onSetAll(!allOn)}
          onClick={(e) => {
            // 点组勾选不展开/收起面板
            e.preventDefault()
            e.stopPropagation()
            onSetAll(!allOn)
          }}
          aria-label={`全选 ${poseName}`}
        />
        <span className="dice-pose-group-name">{poseName}</span>
        <span className="muted dice-pose-group-count">
          {sel}/{total}
        </span>
      </summary>
      <div className="dice-pose-grid">
        {entries.map((p) => {
          const on = poseSel.has(p.id)
          const url = depthUrl(p)
          return (
            <button
              key={p.id}
              type="button"
              className={`dice-pose-item ${on ? 'on' : ''}`}
              onClick={() => onToggle(p.id)}
              title={`${p.poseName} · ${p.id}`}
              aria-pressed={on}
            >
              {url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={url} alt={`${p.poseName} ${p.id}`} loading="lazy" />
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

// 移动端二级页：单字段详情。全屏覆盖，Esc 返回；编辑即防抖落库（与桌面共用 handler）。
function DiceFieldDetail({
  field,
  enabled,
  onRename,
  onTier,
  onRoll,
  onRemove,
  onClose,
}: {
  field: LoadedField
  enabled: Record<Tier, boolean>
  onRename: (patch: Partial<LoadedField>) => void
  onTier: (tier: Tier, patch: Partial<TierConfig>) => void
  onRoll: () => void
  onRemove: () => void
  onClose: () => void
}) {
  const poolTotal = TIERS.filter((t) => enabled[t]).reduce(
    (sum, t) => sum + wordsOf(tierOf(field, t).values).length,
    0,
  )
  const takeTotal = TIERS.filter((t) => enabled[t]).reduce(
    (sum, t) => sum + (wordsOf(tierOf(field, t).values).length > 0 ? tierOf(field, t).max : 0),
    0,
  )
  return (
    <div className="dice-detail" role="dialog" aria-modal="true" aria-label={`编辑字段 ${field.name}`}>
      <div className="dice-detail-head">
        <button type="button" className="quiet dice-detail-back" onClick={onClose}>
          ‹ 返回
        </button>
        <input
          className="dice-name"
          value={field.name}
          onChange={(e) => onRename({ name: e.target.value })}
          aria-label="字段名"
        />
        <button type="button" className="dice-roll" onClick={onRoll} title="本字段掷骰">
          🎲
        </button>
      </div>
      <div className="dice-detail-tiers">
        {TIERS.map((tier) => {
          const cfg = tierOf(field, tier)
          const pool = wordsOf(cfg.values).length
          const picks = field.picked[tier] ?? []
          return (
            <div key={tier} className={`dice-tier ${enabled[tier] ? 'on' : 'off'}`}>
              <div className="dice-tier-row">
                <span className={`dice-tier-label tier-${tier}`}>{tier}</span>
                <label className="dice-count">
                  取
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={cfg.max}
                    value={cfg.min}
                    onChange={(e) => {
                      const min = Math.min(99, Math.max(0, Number(e.target.value) || 0))
                      onTier(tier, { min, max: Math.max(min, cfg.max) })
                    }}
                  />
                  –
                  <input
                    type="number"
                    inputMode="numeric"
                    min={cfg.min}
                    max={99}
                    value={cfg.max}
                    onChange={(e) => {
                      const max = Math.min(99, Math.max(0, Number(e.target.value) || 0))
                      onTier(tier, { max, min: Math.min(max, cfg.min) })
                    }}
                  />
                  个
                </label>
                <span className="dice-pool">池 {pool}</span>
              </div>
              {picks.length > 0 ? (
                <span className="dice-picked mono">{picks.join(', ')}</span>
              ) : null}
              <textarea
                className="dice-tier-open"
                rows={4}
                value={cfg.values}
                placeholder={`${tier} 层候选词，逗号分隔`}
                onChange={(e) => onTier(tier, { values: e.target.value })}
              />
            </div>
          )
        })}
      </div>
      <div className="dice-detail-foot">
        <span className="muted">
          抽取 ≤{takeTotal} / 池 {poolTotal}
        </span>
        <button
          type="button"
          className="quiet dice-detail-remove"
          onClick={() => {
            if (window.confirm(`删除字段 ${field.name}？`)) onRemove()
          }}
        >
          删除字段
        </button>
      </div>
    </div>
  )
}
