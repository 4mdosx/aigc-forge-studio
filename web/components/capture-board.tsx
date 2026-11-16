'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'

import { api } from '@/lib/api'
import { fail, messageOf, notify } from '@/lib/notify'

interface FolderInfo {
  name: string
  done: number
  processing: number
}

interface CaptureItem {
  id: string
  status: string
  error: string | null
  source: string | null
  record: string | null
  width: number | null
  height: number | null
  createdAt: string | null
  rawUrl: string | null
  imageUrl: string | null
}

export function CaptureBoard() {
  const [folders, setFolders] = useState<FolderInfo[]>([])
  const [folder, setFolder] = useState<string | null>(null)
  const [items, setItems] = useState<CaptureItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [url, setUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // 新增 / 改名的行内输入框：null = 关闭
  const [newName, setNewName] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState<string | null>(null)

  const loadFolders = useCallback(async () => {
    try {
      const body = await api<{ folders: FolderInfo[] }>('capture/folders')
      setFolders(body.folders)
      setFolder((cur) =>
        cur && body.folders.some((f) => f.name === cur)
          ? cur
          : (body.folders[0]?.name ?? null),
      )
      return body.folders
    } catch (err) {
      fail(messageOf(err))
      return []
    }
  }, [])

  const loadItems = useCallback(async (name: string) => {
    try {
      const body = await api<{ items: CaptureItem[] }>(
        `capture/items?folder=${encodeURIComponent(name)}`,
      )
      setItems(body.items)
      setLoaded(true)
    } catch (err) {
      fail(messageOf(err))
    }
  }, [])

  useEffect(() => {
    void loadFolders()
  }, [loadFolders])

  useEffect(() => {
    if (folder) void loadItems(folder)
    else {
      setItems([])
      setLoaded(true)
    }
  }, [folder, loadItems])

  // 有预处理中条目时 2.5s 轮询，全部落定即停
  useEffect(() => {
    if (!folder || !items.some((item) => item.status === 'processing')) return
    const timer = setInterval(() => void loadItems(folder), 2500)
    return () => clearInterval(timer)
  }, [items, folder, loadItems])

  async function submitPin(event: FormEvent) {
    event.preventDefault()
    if (!folder || url.trim() === '') return
    setSubmitting(true)
    try {
      await api('capture/pins', {
        method: 'POST',
        body: JSON.stringify({ url: url.trim(), folder }),
      })
      notify('已下载原图，预处理进行中')
      setUrl('')
      await loadItems(folder)
    } catch (err) {
      fail(messageOf(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function createFolder() {
    const name = newName?.trim() ?? ''
    if (name === '') return
    try {
      await api('capture/folders', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      setNewName(null)
      await loadFolders()
      setFolder(name.toLowerCase())
    } catch (err) {
      fail(messageOf(err))
    }
  }

  async function renameFolder() {
  const from = renameValue === null ? null : (folder ?? null)
  const to = renameValue?.trim().toLowerCase() ?? ''
    if (!from || to === '') return
    try {
      await api('capture/folders/rename', {
        method: 'POST',
        body: JSON.stringify({ from, to }),
      })
      setRenameValue(null)
      await loadFolders()
      setFolder(to)
    } catch (err) {
      fail(messageOf(err))
    }
  }

  const current = folders.find((f) => f.name === folder) ?? null

  return (
    <>
      <section className="panel">
        <div className="column-head">
          <h2>采集</h2>
          <button type="button" className="quiet" onClick={() => void loadFolders()}>
            刷新
          </button>
        </div>

        <div className="chips">
          {folders.map((f) => (
            <button
              key={f.name}
              type="button"
              className={f.name === folder ? 'active' : ''}
              onClick={() => setFolder(f.name)}
            >
              {f.name}
              {f.processing > 0 ? ` ·${f.processing}` : ''}
            </button>
          ))}
          {newName === null ? (
            <button
              type="button"
              className="quiet"
              onClick={() => setNewName('')}
            >
              ＋ 新增
            </button>
          ) : (
            <span className="row inline-editor">
              <input
                autoFocus
                placeholder="folder 名（小写字母/数字/-/_）"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void createFolder()
                  if (event.key === 'Escape') setNewName(null)
                }}
              />
              <button type="button" onClick={() => void createFolder()}>
                建
              </button>
              <button type="button" className="quiet" onClick={() => setNewName(null)}>
                取消
              </button>
            </span>
          )}
          {folder && renameValue === null ? (
            <button
              type="button"
              className="quiet"
              onClick={() => setRenameValue(folder)}
            >
              改名
            </button>
          ) : null}
          {renameValue !== null ? (
            <span className="row inline-editor">
              <input
                autoFocus
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void renameFolder()
                  if (event.key === 'Escape') setRenameValue(null)
                }}
              />
              <button type="button" onClick={() => void renameFolder()}>
                改
              </button>
              <button type="button" className="quiet" onClick={() => setRenameValue(null)}>
                取消
              </button>
            </span>
          ) : null}
        </div>

        <form onSubmit={(event) => void submitPin(event)}>
          <div className="capture-input">
            <input
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              enterKeyHint="send"
              placeholder="粘贴 Pinterest 链接（pin.it 短链也可以）"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <button type="submit" disabled={submitting || folder === null || url.trim() === ''}>
              {submitting ? '下载中…' : '采集'}
            </button>
          </div>
        </form>
        <p className="muted">
          图片先落到 folder 的 raw/，随后异步出预处理 jpg（长边 ≤3072）。整理、删除直接在
          data/capture/ 里做。
        </p>
      </section>

      <section className="panel">
        <div className="column-head">
          <h2 className="mono">{folder ?? '未选择 folder'}</h2>
          {current ? (
            <span className="muted">
              完成 {current.done}
              {current.processing > 0 ? ` · 处理中 ${current.processing}` : ''}
            </span>
          ) : null}
        </div>
        {!loaded ? (
          <p className="muted">加载中…</p>
        ) : items.length === 0 ? (
          <p className="muted">这个 folder 还是空的，粘贴链接开始采集。</p>
        ) : (
          <div className="capture-grid">
            {items.map((item) => (
              <CaptureCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </section>
    </>
  )
}

function CaptureCard({ item }: { item: CaptureItem }) {
  const href = item.imageUrl ?? item.rawUrl
  const meta = [
    item.width && item.height ? `${item.width}×${item.height}` : null,
    item.record === 'originals' ? '原图' : null,
    item.createdAt ? item.createdAt.slice(5, 16).replace('T', ' ') : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <a className="capture-card" href={href ?? undefined} target="_blank" rel="noreferrer">
      {href ? (
        <img src={href} alt={item.id} loading="lazy" />
      ) : (
        <span className="capture-missing">{item.status === 'processing' ? '处理中…' : '无图'}</span>
      )}
      <span className="capture-cap">
        <span className={`capture-badge ${item.status}`}>
          {item.status === 'processing'
            ? '处理中'
            : item.status === 'failed'
              ? '失败'
              : '完成'}
        </span>
        {meta ? ` ${meta}` : ''}
      </span>
      {item.error ? <span className="capture-error">{item.error}</span> : null}
    </a>
  )
}
