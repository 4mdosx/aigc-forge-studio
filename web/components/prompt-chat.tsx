'use client'

import { ImagePlus, Send } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

import { api } from '@/lib/api'
import { applyPatch, modelSystem, parseReply, type CreativeIntent } from '@/lib/intent'
import { fail, messageOf, tell } from '@/lib/notify'
import { readPromptTemplates } from '@/lib/prompt-templates'
import type { Chat, ChatMessage, PromptTemplate } from '@/lib/types'

interface ChatSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export function PromptChat({ onUsePrompt }: { onUsePrompt: (text: string) => void }) {
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [templates, setTemplates] = useState<PromptTemplate[]>([])
  const [templateId, setTemplateId] = useState('')
  const [systemText, setSystemText] = useState('')
  const [result, setResult] = useState<CreativeIntent | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [chat, setChat] = useState<Chat | null>(null)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState('')
  const [busy, setBusy] = useState(false)
  const log = useRef<HTMLDivElement>(null)
  const sending = useRef(false)

  useEffect(() => {
    let stop = false
    async function load() {
      try {
        const [listed, templates] = await Promise.all([
          api<{ chats: ChatSummary[]; models: string[] }>('chats'),
          fetchTemplates(),
        ])
        if (stop) return
        setChats(listed.chats)
        setTemplates(templates)
        setModels(listed.models)
        setModel((current) =>
          current && listed.models.includes(current) ? current : (listed.models[0] ?? ''),
        )
        const first = templates[0]
        if (first) {
          setTemplateId(first.id)
          setSystemText(first.system)
          setResult(structuredClone(first.initialResult))
        }
        const latest = listed.chats[0]
        if (latest && first) {
          const opened = await api<Chat>(`chats/${latest.id}`)
          if (stop) return
          showChat(opened, first, setChat, setResult)
        }
      } catch (err) {
        if (!stop) fail(messageOf(err))
      }
    }
    void load()
    return () => {
      stop = true
    }
  }, [])

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight })
  }, [chat?.messages.length, pending, busy])

  function chooseTemplate(id: string) {
    const template = templates.find((item) => item.id === id)
    if (!template || chat) return
    setTemplateId(id)
    setSystemText(template.system)
    setResult(structuredClone(template.initialResult))
  }

  async function openChat(id: string) {
    if (id === '') {
      setChat(null)
      const template = templates.find((item) => item.id === templateId)
      if (template) {
        setSystemText(template.system)
        setResult(structuredClone(template.initialResult))
      }
      return
    }
    try {
      const opened = await api<Chat>(`chats/${id}`)
      const template = templates.find((item) => item.id === templateId) ?? templates[0]
      if (!template) return
      showChat(opened, template, setChat, setResult)
    } catch (err) {
      fail(messageOf(err))
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    const content = draft.trim()
    const template = templates.find((item) => item.id === templateId)
    if (content === '' || !template || !result || sending.current) return
    sending.current = true
    setBusy(true)
    setPending(content)
    setDraft('')
    try {
      const next = await api<Chat>(chat ? `chats/${chat.id}/messages` : 'chats', {
        method: 'POST',
        body: JSON.stringify({
          content,
          ...(model ? { model } : {}),
          system: modelSystem(systemText, result),
        }),
      })
      setChat(next)
      setPending('')
      const played = replay(next.messages, structuredClone(template.initialResult))
      setResult(played.result)
      if (played.error) fail(`创作意图没有更新：${played.error}`)
      setChats((current) => [
        {
          id: next.id,
          title: next.title,
          createdAt: next.createdAt,
          updatedAt: next.updatedAt,
        },
        ...current.filter((item) => item.id !== next.id),
      ])
    } catch (err) {
      setDraft(content)
      setPending('')
      fail(messageOf(err))
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  function onComposeKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  async function copy(content: string) {
    try {
      await navigator.clipboard.writeText(content)
      tell('已复制')
    } catch (err) {
      fail(messageOf(err))
    }
  }

  const templateName = templates.find((item) => item.id === templateId)?.name ?? ''
  const view = result ? intentView(result) : null

  return (
    <>
      <p className="muted">说出想画的内容，整理成可以直接出图的一句。</p>
      <div className="chat-controls">
        {models.length > 0 ? (
          <select aria-label="模型" value={model} onChange={(event) => setModel(event.target.value)}>
            {models.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        ) : null}
        {templates.length > 1 ? (
          <select
            aria-label="模板"
            value={templateId}
            disabled={chat !== null || busy}
            onChange={(event) => chooseTemplate(event.target.value)}
          >
            {templates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        ) : null}
        <select
          aria-label="对话"
          value={chat?.id ?? ''}
          onChange={(event) => void openChat(event.target.value)}
        >
          <option value="">新对话</option>
          {chats.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      </div>
      <details className="fold">
        <summary>模板{templateName ? ` · ${templateName}` : ''}</summary>
        <textarea
          className="template"
          value={systemText}
          disabled={busy}
          onChange={(event) => setSystemText(event.target.value)}
        />
      </details>
      {view ? (
        <div className="intent-card">
          <div className="intent">
            {view.rows.length === 0 ? (
              <p className="muted">说出主体、场景或风格，意图会写在这里。</p>
            ) : (
              <>
                <p className="intent-prompt">{view.prompt}</p>
                <dl>
                  {view.rows.map((row) => (
                    <div className="intent-row" key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </div>
          {view.prompt ? (
            <div className="intent-actions">
              <button type="button" className="quiet" onClick={() => void copy(view.prompt)}>
                复制
              </button>
              <button type="button" onClick={() => onUsePrompt(view.prompt)}>
                <ImagePlus size={15} />
                用于出图
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="chat-log" ref={log}>
        {chat?.messages.map((message) => (
          <div key={message.id} className={`bubble ${message.role}`}>
            <div className="bubble-head">
              <span>{message.role === 'user' ? '你' : '助手'}</span>
              {message.role === 'assistant' ? (
                <button type="button" className="text-button" onClick={() => void copy(spoken(message))}>
                  复制
                </button>
              ) : null}
            </div>
            <p>{spoken(message)}</p>
          </div>
        ))}
        {pending ? (
          <div className="bubble user">
            <div className="bubble-head">
              <span>你</span>
            </div>
            <p>{pending}</p>
          </div>
        ) : null}
        {busy ? (
          <div className="bubble assistant">
            <div className="bubble-head">
              <span>助手</span>
            </div>
            <p>正在整理…</p>
          </div>
        ) : null}
        {!chat?.messages.length && !pending ? <p className="muted">从一句话开始。</p> : null}
      </div>
      <form className="composer" onSubmit={(event) => void send(event)}>
        <textarea
          value={draft}
          placeholder="描述你想画的图，Enter 发送"
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onComposeKey}
        />
        <button disabled={busy || draft.trim() === '' || systemText.trim() === '' || !result}>
          <Send size={15} />
          {busy ? '等待' : '发送'}
        </button>
      </form>
    </>
  )
}

function spoken(message: ChatMessage): string {
  return replyOf(message)?.message ?? message.content
}

async function fetchTemplates(): Promise<PromptTemplate[]> {
  const response = await fetch('/api/prompt-templates', { cache: 'no-store' })
  const body = (await response.json()) as { templates?: unknown; error?: string }
  if (!response.ok) throw new Error(body.error || 'cannot load prompt templates')
  const templates = readPromptTemplates(body.templates)
  if (templates.length === 0) throw new Error('没有可用的提示词模板')
  return templates
}

function showChat(
  opened: Chat,
  template: PromptTemplate,
  setChat: (chat: Chat) => void,
  setResult: (result: CreativeIntent) => void,
): void {
  setChat(opened)
  const played = replay(opened.messages, structuredClone(template.initialResult))
  setResult(played.result)
  if (played.error) fail(`创作意图没有更新：${played.error}`)
}

function replay(
  messages: ChatMessage[],
  initial: CreativeIntent,
): { result: CreativeIntent; error: string } {
  let current = initial
  let error = ''
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const reply = replyOf(message)
    if (!reply) continue
    try {
      current = applyPatch(current, reply.patch)
      error = ''
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }
  return { result: current, error }
}

function replyOf(message: ChatMessage): { message: string; patch: unknown } | null {
  try {
    return parseReply(message.content)
  } catch {
    return null
  }
}

function intentView(intent: CreativeIntent): { rows: Array<{ label: string; value: string }>; prompt: string } {
  const rows = [
    ['主体', joinText([intent.subject.type, intent.subject.description])],
    ['服装', joinText([intent.outfit.clothing, ...intent.outfit.accessories])],
    ['姿态', joinText([intent.pose.action, intent.pose.expression])],
    ['构图', joinText([intent.composition.shot, intent.composition.view, intent.composition.framing])],
    ['环境', intent.environment.background.trim()],
    ['光线', intent.lighting.type.trim()],
    ['风格', joinText([intent.style.genre, intent.style.rendering])],
    ['排除', intent.constraints.exclude.map((item) => item.trim()).filter(Boolean).join('、')],
  ]
    .filter((row): row is [string, string] => row[1] !== '')
    .map(([label, value]) => ({ label, value }))
  const body = rows.filter((row) => row.label !== '排除').map((row) => row.value)
  const exclude = rows.find((row) => row.label === '排除')?.value.replaceAll('、', ', ')
  const prompt = [...body, ...(exclude ? [`without ${exclude}`] : [])].join(', ')
  return { rows, prompt }
}

function joinText(parts: string[]): string {
  const unique: string[] = []
  for (const item of parts) {
    const text = item.trim()
    if (!text || unique.includes(text)) continue
    unique.push(text)
  }
  return unique.join('，')
}
