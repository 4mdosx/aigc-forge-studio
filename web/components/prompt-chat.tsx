'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'

import { api } from '@/lib/api'
import type { Chat } from '@/lib/types'

interface ChatSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export function PromptChat() {
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [chat, setChat] = useState<Chat | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const log = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let stop = false
    async function load() {
      try {
        const listed = await api<{ chats: ChatSummary[]; models: string[] }>('chats')
        if (stop) return
        setChats(listed.chats)
        setModels(listed.models)
        setModel((current) =>
          current && listed.models.includes(current) ? current : (listed.models[0] ?? ''),
        )
        const latest = listed.chats[0]
        if (latest) setChat(await api<Chat>(`chats/${latest.id}`))
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void load()
    return () => {
      stop = true
    }
  }, [])

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight })
  }, [chat?.messages.length])

  async function openChat(id: string) {
    setError('')
    if (id === '') {
      setChat(null)
      return
    }
    try {
      setChat(await api<Chat>(`chats/${id}`))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    const content = draft.trim()
    if (content === '') return
    setBusy(true)
    setError('')
    try {
      const next = await api<Chat>(chat ? `chats/${chat.id}/messages` : 'chats', {
        method: 'POST',
        body: JSON.stringify({ content, ...(model ? { model } : {}) }),
      })
      setChat(next)
      setDraft('')
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
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function copy(content: string) {
    try {
      await navigator.clipboard.writeText(content)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <p className="muted">写出图用的提示词。定稿后复制英文提示词，贴到 Work 的 text。</p>
      {error ? <div className="error">{error}</div> : null}
      {models.length > 0 ? (
        <select value={model} onChange={(event) => setModel(event.target.value)}>
          {models.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      ) : null}
      <select value={chat?.id ?? ''} onChange={(event) => void openChat(event.target.value)}>
        <option value="">新对话</option>
        {chats.map((item) => (
          <option key={item.id} value={item.id}>
            {item.title}
          </option>
        ))}
      </select>
      <div className="chat-log" ref={log}>
        {chat?.messages.map((message) => (
          <div key={message.id}>
            <div className="item-line">
              <span className="muted">{message.role === 'user' ? '你' : '助手'}</span>
              {message.role === 'assistant' ? (
                <button type="button" className="quiet" onClick={() => void copy(message.content)}>
                  复制
                </button>
              ) : null}
            </div>
            <p>{message.content}</p>
          </div>
        ))}
      </div>
      <form onSubmit={(event) => void send(event)}>
        <textarea
          value={draft}
          placeholder="描述你想画的图"
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="row">
          <button disabled={busy || draft.trim() === ''}>{busy ? '等待回复' : '发送'}</button>
        </div>
      </form>
    </>
  )
}
