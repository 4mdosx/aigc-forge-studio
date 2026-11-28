'use client'

import { useCallback, useState } from 'react'

import { api } from '@/lib/api'
import { fail, messageOf } from '@/lib/notify'

export type PromptGroupKey = 'trigger' | 'identity' | 'clothing' | 'pose'
export type PromptGroups = Record<PromptGroupKey, string[]>

export const GROUP_LABELS: Record<PromptGroupKey, string> = {
  trigger: '触发词与质量',
  identity: '外貌与身份',
  clothing: '服装与题材',
  pose: '姿势与构图',
}

const GROUP_KEYS: PromptGroupKey[] = ['trigger', 'identity', 'clothing', 'pose']
const EMPTY: PromptGroups = { trigger: [], identity: [], clothing: [], pose: [] }

interface SplitBody {
  groups: PromptGroups
  joined: string
}

interface RecomposeBody {
  mode: 'llm' | 'canonical'
  text: string
  model?: string
  theme?: string | null
  themeLabel?: string
}

interface ThemeDraftBody {
  mode: 'theme-draft'
  model: string
  table: unknown
  raw: string
}

type ResultState = Record<
  'llm' | 'canonical',
  { text: string; themeLabel: string; error: string; busy: boolean }
>

const INITIAL_RESULT: ResultState = {
  llm: { text: '', themeLabel: '', error: '', busy: false },
  canonical: { text: '', themeLabel: '', error: '', busy: false },
}

function flatten(groups: PromptGroups): string {
  return GROUP_KEYS.flatMap((key) => groups[key]).join(', ')
}

// 首页 prompt 工作台：平铺输入 → 四组 → 两模式并行重组，结果平行展示。
// 只服务首页 QuickGenerate；项目其他结构化 prompt 组件不动。
export function PromptStudio({ onPrompt }: { onPrompt: (text: string) => void }) {
  const [flat, setFlat] = useState('')
  const [groups, setGroups] = useState<PromptGroups>(EMPTY)
  const [results, setResults] = useState<ResultState>(INITIAL_RESULT)
  const [adopted, setAdopted] = useState<{ mode: 'llm' | 'canonical'; text: string } | null>(null)

  const applyGroups = useCallback((next: PromptGroups) => {
    setGroups(next)
    setAdopted(null)
    onPrompt(flatten(next))
  }, [onPrompt])

  const split = async () => {
    if (flat.trim() === '') return
    try {
      const body = await api<SplitBody>('prompt/split', {
        method: 'POST',
        body: JSON.stringify({ text: flat }),
      })
      applyGroups(body.groups)
    } catch (err) {
      fail(messageOf(err))
    }
  }

  const editGroup = (key: PromptGroupKey, value: string) => {
    const tokens = value.split(/[,，\n]/).map((v) => v.trim()).filter(Boolean)
    setGroups((current) => {
      const next = { ...current, [key]: tokens }
      onPrompt(flatten(next))
      return next
    })
    setAdopted(null)
  }

  // 两模式并行发起，各自独立回填/报错，互不阻塞
  const recompose = async () => {
    const input = flatten(groups)
    if (input.trim() === '') return
    setResults({
      llm: { text: '', themeLabel: '', error: '', busy: true },
      canonical: { text: '', themeLabel: '', error: '', busy: true },
    })
    const run = async (mode: 'llm' | 'canonical') => {
      try {
        const body = await api<RecomposeBody>('prompt/recompose', {
          method: 'POST',
          body: JSON.stringify({ mode, groups }),
        })
        setResults((current) => ({
          ...current,
          [mode]: {
            text: body.text,
            themeLabel: mode === 'canonical' ? (body.themeLabel ?? '') : '',
            error: '',
            busy: false,
          },
        }))
      } catch (err) {
        setResults((current) => ({
          ...current,
          [mode]: { text: '', themeLabel: '', error: messageOf(err), busy: false },
        }))
      }
    }
    await Promise.all([run('llm'), run('canonical')])
  }

  const adopt = (mode: 'llm' | 'canonical', text: string) => {
    setAdopted({ mode, text })
    onPrompt(text)
  }

  const [draftTags, setDraftTags] = useState('')
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState('')
  const [draftBusy, setDraftBusy] = useState(false)

  // 一串 tag → LLM 产出题材表草案；只回显不落盘，人审过再手动并进 bank。
  const generateTheme = async () => {
    if (draftTags.trim() === '') return
    setDraftBusy(true)
    setDraft('')
    setDraftError('')
    try {
      const body = await api<ThemeDraftBody>('prompt/theme-from-tags', {
        method: 'POST',
        body: JSON.stringify({ tags: draftTags }),
      })
      setDraft(JSON.stringify(body.table, null, 2))
    } catch (err) {
      setDraftError(messageOf(err))
    } finally {
      setDraftBusy(false)
    }
  }

  return (
    <div className="prompt-studio">
      <div className="prompt-studio-head">
        <strong>Prompt 工作台</strong>
        <span className="muted">平铺 → 四组 → 双模式重组</span>
      </div>

      <label className="prompt-studio-flat">
        平铺 prompt（粘贴长串后拆分）
        <textarea
          className="prose"
          rows={2}
          value={flat}
          placeholder="1girl, animal_ears, playboy_bunny, black_leotard, full_body…"
          onChange={(event) => setFlat(event.target.value)}
        />
      </label>
      <button type="button" className="prompt-studio-btn" disabled={flat.trim() === ''} onClick={() => void split()}>
        拆成四组
      </button>

      <div className="prompt-studio-groups">
        {GROUP_KEYS.map((key) => (
          <label key={key} className="prompt-studio-group">
            <span>
              {GROUP_LABELS[key]}
              <span className="prompt-studio-count">{groups[key].length}</span>
            </span>
            <textarea
              rows={2}
              value={groups[key].join(', ')}
              placeholder={`${key === 'trigger' ? 'zxstyle, masterpiece' : '逗号分隔'}`}
              onChange={(event) => editGroup(key, event.target.value)}
            />
          </label>
        ))}
      </div>

      <button
        type="button"
        className="prompt-studio-btn primary"
        disabled={flatten(groups).trim() === '' || results.llm.busy || results.canonical.busy}
        onClick={() => void recompose()}
      >
        {results.llm.busy || results.canonical.busy ? '重组中…' : '双模式重组'}
      </button>

      <div className="prompt-studio-results">
        {(['llm', 'canonical'] as const).map((mode) => (
          <div key={mode} className="prompt-studio-result">
            <div className="prompt-studio-result-head">
              <strong>{mode === 'llm' ? 'Chat Gateway' : 'Canonical 表'}</strong>
              {mode === 'canonical' && results[mode].themeLabel ? (
                <span className="prompt-studio-theme">命中 {results[mode].themeLabel}</span>
              ) : null}
              {results[mode].busy ? <span className="muted">生成中…</span> : null}
            </div>
            <p className="prompt-studio-result-text">
              {results[mode].error
                ? <span className="prompt-studio-error">{results[mode].error}</span>
                : results[mode].text || <span className="muted">—</span>}
            </p>
            {results[mode].text && !results[mode].busy ? (
              <button
                type="button"
                className="prompt-studio-btn"
                onClick={() => adopt(mode, results[mode].text)}
              >
                {adopted?.mode === mode ? '已采用' : '采用此结果'}
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {adopted ? (
        <p className="muted prompt-studio-adopted">
          已采用 {adopted.mode === 'llm' ? 'Chat Gateway' : 'Canonical 表'} 结果作为生成 prompt；
          编辑任意组会切回四组拼装。
        </p>
      ) : null}

      <details className="prompt-studio-theme-gen">
        <summary>题材表生成器 · 一串 tag → 题材表草案</summary>
        <p className="muted prompt-studio-theme-hint">
          输入同一题材的 WD14 tag，让 LLM 产出一张可入 bank 的题材表。只回显不落盘；
          人审过显式 router 和 compose 映射后，再手动并进 data/prompt-canonical.json。
        </p>
        <textarea
          className="prose"
          rows={3}
          value={draftTags}
          placeholder="playboy_bunny, rabbit_ears, black_leotard, highleg_leotard, bar_(place), …"
          onChange={(event) => setDraftTags(event.target.value)}
        />
        <button
          type="button"
          className="prompt-studio-btn"
          disabled={draftTags.trim() === '' || draftBusy}
          onClick={() => void generateTheme()}
        >
          {draftBusy ? '生成中…' : '生成题材表'}
        </button>
        {draftError ? <p className="prompt-studio-error">{draftError}</p> : null}
        {draft ? (
          <>
            <textarea className="prompt-studio-draft" readOnly rows={12} value={draft} />
            <button
              type="button"
              className="prompt-studio-btn"
              onClick={() => void navigator.clipboard.writeText(draft)}
            >
              复制 JSON
            </button>
          </>
        ) : null}
      </details>
    </div>
  )
}
