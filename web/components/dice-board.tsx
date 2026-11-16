'use client'

import { useCallback, useEffect, useState } from 'react'

// 🎲 掷骰工作台：每个输入框对应 prompt 模版结构化的一个字段（creative-intent patch）。
// 输入框写逗号分隔的候选词，数字 = 每次取几个；🎲 抽词后组成 JSON 展示。
// 纯前端：候选词存 localStorage，不发 runner 请求。

interface DiceField {
  id: string
  name: string
  values: string
  count: number
  picked: string[]
}

// 默认字段集 = creative-intent 的 patch 结构（data/promptTemplates.ts）
const DEFAULT_FIELDS: DiceField[] = [
  {
    id: 'subject.type',
    name: 'subject.type',
    values: '1girl, solo, 1boy, 2girls, janedoe',
    count: 1,
    picked: [],
  },
  {
    id: 'subject.description',
    name: 'subject.description',
    values:
      'silver hair, long hair, twintails, blue eyes, red eyes, blonde hair, black hair, green eyes, ponytail, short hair, purple eyes, hair ornament, tall female, petite',
    count: 3,
    picked: [],
  },
  {
    id: 'outfit.clothing',
    name: 'outfit.clothing',
    values:
      'black gothic dress, white dress, kimono, school uniform, sailor uniform, jacket, hoodie, qipao, maid dress, combat suit, sweater, bikini armor, lab coat, cape',
    count: 2,
    picked: [],
  },
  {
    id: 'outfit.accessories',
    name: 'outfit.accessories',
    values:
      'earrings, necklace, hair ribbon, choker, glasses, bracelet, thigh strap, gloves, hat, beret, headphones, cyberpunk visor',
    count: 2,
    picked: [],
  },
  {
    id: 'pose.action',
    name: 'pose.action',
    values:
      'standing, arms behind back, hands in pockets, sitting, crossed legs, leaning forward, looking back, walking, running, crouching, arms crossed, holding weapon',
    count: 2,
    picked: [],
  },
  {
    id: 'pose.expression',
    name: 'pose.expression',
    values:
      'smile, closed mouth, melancholy, smirk, serious, blush, open mouth, expressionless, angry, surprised, gentle smile, grin',
    count: 1,
    picked: [],
  },
  {
    id: 'composition.shot',
    name: 'composition.shot',
    values: 'full body, upper body, cowboy shot, portrait, bust, wide shot, close-up',
    count: 1,
    picked: [],
  },
  {
    id: 'composition.view',
    name: 'composition.view',
    values: 'from side, from above, from below, from behind, dynamic angle, dutch angle, front view',
    count: 1,
    picked: [],
  },
  {
    id: 'composition.framing',
    name: 'composition.framing',
    values: 'cowboy shot, portrait, centered framing, rule of thirds, symmetric framing',
    count: 1,
    picked: [],
  },
  {
    id: 'environment.background',
    name: 'environment.background',
    values:
      'simple background, white background, cityscape, night city, classroom, forest, beach, ruined city, laboratory, neon lights, underwater, cyberspace, gray background',
    count: 1,
    picked: [],
  },
  {
    id: 'lighting.type',
    name: 'lighting.type',
    values:
      'soft lighting, backlighting, moonlight, rim lighting, dramatic shadow, sunset glow, neon lighting, dim light, spotlight, dappled sunlight',
    count: 1,
    picked: [],
  },
  {
    id: 'style.rendering',
    name: 'style.rendering',
    values: 'masterpiece, best quality, very aesthetic, absurdres, highres, detailed background',
    count: 3,
    picked: [],
  },
  {
    id: 'constraints.exclude',
    name: 'constraints.exclude',
    values:
      'bad hands, extra fingers, watermark, signature, worst quality, low quality, jpeg artifacts, blurry, extra limbs, bad anatomy, text, logo',
    count: 6,
    picked: [],
  },
]

const STORAGE_KEY = 'dice-fields-v1'

function pickWords(values: string, count: number): string[] {
  const words = [...new Set(values.split(/[,;\n]/).map((w) => w.trim()).filter((w) => w !== ''))]
  const n = Math.max(0, Math.min(count, words.length))
  // 部分洗牌取前 n 个
  for (let i = 0; i < n; i += 1) {
    const j = i + Math.floor(Math.random() * (words.length - i))
    ;[words[i], words[j]] = [words[j], words[i]]
  }
  return words.slice(0, n)
}

function loadFields(): DiceField[] {
  if (typeof window === 'undefined') return DEFAULT_FIELDS
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_FIELDS
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_FIELDS
    const byName = new Map(
      parsed
        .filter((f): f is DiceField => Boolean(f) && typeof (f as DiceField).name === 'string')
        .map((f) => [f.name, f]),
    )
    // 以默认字段顺序为骨架，恢复用户改过的 values/count；新增字段追加
    const restored = DEFAULT_FIELDS.map((d) => {
      const saved = byName.get(d.name)
      return saved ? { ...d, values: saved.values, count: saved.count, picked: [] } : d
    })
    for (const f of parsed) {
      if (typeof f?.name === 'string' && !DEFAULT_FIELDS.some((d) => d.name === f.name)) {
        restored.push({ ...f, picked: [] })
      }
    }
    return restored
  } catch {
    return DEFAULT_FIELDS
  }
}

export function DiceBoard() {
  const [fields, setFields] = useState<DiceField[]>(DEFAULT_FIELDS)
  const [loaded, setLoaded] = useState(false)
  const [rolled, setRolled] = useState(false)

  useEffect(() => {
    setFields(loadFields())
    setLoaded(true)
  }, [])

  useEffect(() => {
    if (!loaded) return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fields))
    } catch {
      // 存不进去就只当会话内草稿
    }
  }, [fields, loaded])

  const updateField = useCallback((id: string, patch: Partial<DiceField>) => {
    setFields((cur) => cur.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  }, [])

  const rollField = useCallback((id: string) => {
    setFields((cur) =>
      cur.map((f) => (f.id === id ? { ...f, picked: pickWords(f.values, f.count) } : f)),
    )
    setRolled(true)
  }, [])

  const rollAll = useCallback(() => {
    setFields((cur) => cur.map((f) => ({ ...f, picked: pickWords(f.values, f.count) })))
    setRolled(true)
  }, [])

  const addField = useCallback(() => {
    const id = `custom-${Date.now().toString(36)}`
    setFields((cur) => [...cur, { id, name: 'custom.field', values: '', count: 1, picked: [] }])
  }, [])

  const removeField = useCallback((id: string) => {
    setFields((cur) => cur.filter((f) => f.id !== id))
  }, [])

  const resetFields = useCallback(() => {
    setFields(DEFAULT_FIELDS.map((f) => ({ ...f })))
    setRolled(false)
  }, [])

  const composed = Object.fromEntries(
    fields.filter((f) => f.picked.length > 0).map((f) => [f.name, f.picked.join(', ')]),
  )
  const negative = composed['constraints.exclude'] ?? null

  function copyJson() {
    void navigator.clipboard.writeText(JSON.stringify(composed, null, 2))
  }

  return (
    <>
      <section className="panel">
        <div className="column-head">
          <h2>🎲 掷骰工作台</h2>
          <span className="muted">候选词逗号分隔 · 数字 = 取几个 · 存浏览器本地</span>
        </div>
        <div className="row">
          <button type="button" onClick={rollAll}>
            🎲 全部掷骰
          </button>
          <button type="button" className="quiet" onClick={addField}>
            ＋ 加字段
          </button>
          <button type="button" className="quiet" onClick={resetFields}>
            重置为模板默认
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="dice-grid">
          {fields.map((field) => (
            <div key={field.id} className="dice-field">
              <div className="dice-head">
                <input
                  className="dice-name"
                  value={field.name}
                  onChange={(e) => updateField(field.id, { name: e.target.value })}
                  aria-label="字段名"
                />
                <button
                  type="button"
                  className="quiet dice-remove"
                  onClick={() => removeField(field.id)}
                  title="删除字段"
                >
                  ×
                </button>
              </div>
              <textarea
                rows={3}
                value={field.values}
                placeholder="候选词，逗号分隔"
                onChange={(e) => updateField(field.id, { values: e.target.value })}
              />
              <div className="dice-foot">
                <label className="dice-count">
                  取
                  <input
                    type="number"
                    min={0}
                    max={99}
                    value={field.count}
                    onChange={(e) =>
                      updateField(field.id, { count: Math.max(0, Number(e.target.value) || 0) })
                    }
                  />
                  个
                </label>
                <button type="button" className="dice-roll" onClick={() => rollField(field.id)}>
                  🎲
                </button>
                <span className="dice-picked mono">{field.picked.join(', ') || '—'}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="column-head">
          <h2>结果</h2>
          <button type="button" className="quiet" onClick={copyJson} disabled={!rolled}>
            复制 JSON
          </button>
        </div>
        <pre className="dice-json mono">
          {rolled ? JSON.stringify(composed, null, 2) : '按 🎲 生成 JSON'}
        </pre>
        {negative ? (
          <p className="muted">
            负面词（constraints.exclude）： <span className="mono">{negative}</span>
          </p>
        ) : null}
      </section>
    </>
  )
}
