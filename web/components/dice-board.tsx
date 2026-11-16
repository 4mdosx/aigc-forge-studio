'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { api } from '@/lib/api'
import { fail, messageOf } from '@/lib/notify'

// 🎲 掷骰工作台：字段池存 runner SQLite（dice_fields 表，建表时种子默认集）。
// 输入框逗号分隔候选词，数字 = 取几个；🎲 抽词后组成 JSON 展示。
// 配置改动静默防抖 PUT 全量保存；「重置为默认」走 POST /dice/reset。

interface DiceField {
  name: string
  values: string
  count: number
}

interface LoadedField extends DiceField {
  picked: string[]
}

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

const asLoaded = (rows: DiceField[]): LoadedField[] =>
  rows.map((f) => ({ ...f, picked: [] }))

export function DiceBoard() {
  const [fields, setFields] = useState<LoadedField[]>([])
  const [loaded, setLoaded] = useState(false)
  const [rolled, setRolled] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const configOf = (list: LoadedField[]): DiceField[] =>
    list.map((f) => ({ name: f.name, values: f.values, count: f.count }))

  const save = useCallback(async (list: LoadedField[]) => {
    setSaveState('saving')
    try {
      await api('dice/fields', {
        method: 'PUT',
        body: JSON.stringify({ fields: configOf(list) }),
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
        const body = await api<{ fields: DiceField[] }>('dice/fields')
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

  const rollField = useCallback((index: number) => {
    setFields((cur) =>
      cur.map((f, i) => (i === index ? { ...f, picked: pickWords(f.values, f.count) } : f)),
    )
    setRolled(true)
  }, [])

  const rollAll = useCallback(() => {
    setFields((cur) => cur.map((f) => ({ ...f, picked: pickWords(f.values, f.count) })))
    setRolled(true)
  }, [])

  const addField = useCallback(() => {
    setFields((cur) => {
      let name = 'custom.field'
      for (let n = 2; cur.some((f) => f.name === name); n += 1) {
        name = `custom.field${n}`
      }
      const next = [...cur, { name, values: '', count: 1, picked: [] }]
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
        const body = await api<{ fields: DiceField[] }>('dice/fields')
        setFields(asLoaded(body.fields))
        setRolled(false)
        setSaveState('saved')
      } catch (err) {
        fail(messageOf(err))
      }
    })()
  }, [])

  const composed = Object.fromEntries(
    fields.filter((f) => f.picked.length > 0).map((f) => [f.name, f.picked.join(', ')]),
  )
  const negative = composed['constraints.exclude'] ?? null
  // 拼好的正向 prompt：除 constraints.exclude 外按字段顺序拼接
  const joinedPrompt = fields
    .filter((f) => f.name !== 'constraints.exclude' && f.picked.length > 0)
    .map((f) => f.picked.join(', '))
    .join(', ')

  function copyJson() {
    void navigator.clipboard.writeText(JSON.stringify(composed, null, 2))
  }

  return (
    <>
      <section className="panel">
        <div className="column-head">
          <h2>🎲 掷骰工作台</h2>
          <span className="muted">
            候选词逗号分隔 · 数字 = 取几个 · 模版存 runner 数据库
            {saveState === 'saving'
              ? ' · 保存中…'
              : saveState === 'saved'
                ? ' · 已保存'
                : saveState === 'error'
                  ? ' · 保存失败'
                  : ''}
          </span>
        </div>
        <div className="dice-hero">
          <button type="button" className="dice-hero-roll" onClick={rollAll}>
            🎲 一起生成
          </button>
          <button type="button" className="quiet" onClick={addField}>
            ＋ 加字段
          </button>
          <button type="button" className="quiet" onClick={resetToSeed}>
            重置为默认
          </button>
        </div>
      </section>

      <section className="panel">
        {!loaded ? (
          <p className="muted">加载中…</p>
        ) : (
          <div className="dice-grid">
            {fields.map((field, index) => (
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
                <textarea
                  rows={3}
                  value={field.values}
                  placeholder="候选词，逗号分隔"
                  onChange={(e) => updateField(index, { values: e.target.value })}
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
                        updateField(index, { count: Math.max(0, Number(e.target.value) || 0) })
                      }
                    />
                    个
                  </label>
                  <button type="button" className="dice-roll" onClick={() => rollField(index)}>
                    🎲
                  </button>
                  <span className="dice-picked mono">{field.picked.join(', ') || '—'}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="column-head">
          <h2>结果</h2>
          <button type="button" className="quiet" onClick={copyJson} disabled={!rolled}>
            复制 JSON
          </button>
        </div>
        <pre className="dice-json mono">
          {rolled ? JSON.stringify(composed, null, 2) : '按 🎲 一起生成'}
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
