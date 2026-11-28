'use client'

import { useEffect, useState, type FormEvent } from 'react'

import type { Dataset } from '@/components/datasets'
import { fail, messageOf, notify } from '@/lib/notify'

export function DatasetRail({
  items,
  loaded,
  busy,
  focusId,
  only,
  onFocus,
  onOnly,
  onCreate,
  onRename,
  onDelete,
}: {
  items: Dataset[]
  loaded: boolean
  busy: boolean
  focusId: string | null
  only: boolean
  onFocus: (id: string) => void
  onOnly: (only: boolean) => void
  onCreate: (name: string) => Promise<void>
  onRename: (id: string, name: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const focused = items.find((item) => item.id === focusId) ?? null
  const [draft, setDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setRenaming(false)
    setConfirmDelete(false)
    setRenameDraft(focused?.name ?? '')
  }, [focused?.id, focused?.name])

  async function create(event: FormEvent) {
    event.preventDefault()
    const name = draft.trim()
    if (name === '' || busy) return
    try {
      await onCreate(name)
      setDraft('')
    } catch (err) {
      fail(messageOf(err))
    }
  }

  async function rename(event: FormEvent) {
    event.preventDefault()
    if (!focused || busy) return
    const name = renameDraft.trim()
    if (name === '' || name === focused.name) {
      setRenaming(false)
      return
    }
    try {
      await onRename(focused.id, name)
      setRenaming(false)
      notify(`已改名为「${name}」`)
    } catch (err) {
      fail(messageOf(err))
    }
  }

  async function remove() {
    if (!focused || busy) return
    try {
      await onDelete(focused.id)
      notify(`已删除数据集「${focused.name}」`)
      setConfirmDelete(false)
    } catch (err) {
      fail(messageOf(err))
    }
  }

  return (
    <section className="panel dataset-rail">
      <div className="column-head">
        <h2>数据集</h2>
      </div>
      <div className="dataset-rail-body">
        {!loaded ? (
          <p className="muted">加载中…</p>
        ) : items.length === 0 ? (
          <p className="muted">还没有数据集。建一个，再把图片加进去。</p>
        ) : (
          <ul className="dataset-list">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="dataset-pick"
                  aria-pressed={item.id === focusId}
                  onClick={() => onFocus(item.id)}
                >
                  <span className="dataset-pick-name">{item.name}</span>
                  <span className="dataset-pick-count">{item.count}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {focused ? (
        <div className="dataset-rail-actions">
          {renaming ? (
            <form className="dataset-rename" onSubmit={(event) => void rename(event)}>
              <input
                aria-label="数据集名称"
                value={renameDraft}
                autoFocus
                onChange={(event) => setRenameDraft(event.target.value)}
              />
              <button type="submit" disabled={busy || renameDraft.trim() === ''}>
                保存
              </button>
              <button type="button" className="quiet" onClick={() => setRenaming(false)}>
                取消
              </button>
            </form>
          ) : confirmDelete ? (
            <>
              <p className="dataset-rail-note">删除「{focused.name}」。图片仍留在图库。</p>
              <button type="button" disabled={busy} onClick={() => void remove()}>
                确认删除
              </button>
              <button type="button" className="quiet" disabled={busy} onClick={() => setConfirmDelete(false)}>
                取消
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="quiet"
                aria-pressed={only}
                onClick={() => onOnly(!only)}
              >
                {only ? '看全部' : '只看此集'}
              </button>
              <button type="button" className="quiet" onClick={() => setRenaming(true)}>
                改名
              </button>
              <button type="button" className="quiet" onClick={() => setConfirmDelete(true)}>
                删除
              </button>
              <p className="dataset-rail-note">右侧标签改当前这张。多选后用加入、移出。</p>
            </>
          )}
        </div>
      ) : null}
      <form className="dataset-create" onSubmit={(event) => void create(event)}>
        <input
          aria-label="新数据集名称"
          placeholder="新数据集"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={busy || draft.trim() === ''}>
          新建
        </button>
      </form>
    </section>
  )
}
