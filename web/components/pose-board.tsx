'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

import { api } from '@/lib/api'
import { fail, messageOf, notify } from '@/lib/notify'

interface PendingEntry {
  poseName: string
  id: string
  meta: {
    name?: string
    description?: string
    tags?: string[]
    ratio?: string
    canvases?: string[]
    note?: string
    source?: string
    [key: string]: unknown
  }
  files: string[]
  dual: { taskId: string; status: string; image: string | null } | null
  fileUrls: Record<string, string>
}

// 与 runner POSE_ACTIONS 对齐的动作类目
const POSE_NAMES = [
  'sitting',
  'standing',
  'kneeling',
  'lying',
  'squatting',
  'all_fours',
  'split_leg',
  'suspended',
]

const RATIOS = [
  ['auto', '自动（按源图比例）'],
  ['2:3', '2:3（512×768 竖）'],
  ['3:2', '3:2（768×512 横）'],
  ['1:1', '1:1（512×512 方）'],
] as const

export function PoseBoard() {
  const [entries, setEntries] = useState<PendingEntry[]>([])
  const [characters, setCharacters] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const editsRef = useRef<Map<string, { name: string; tags: string }>>(new Map())

  const load = useCallback(async () => {
    try {
      const body = await api<{ entries: PendingEntry[] }>('poses/pending')
      setEntries(body.entries)
      setLoaded(true)
    } catch (err) {
      fail(messageOf(err))
    }
  }, [])

  useEffect(() => {
    load()
    api<{ characters: Array<{ slug: string }> }>('data/characters')
      .then((body) => setCharacters(body.characters.map((c) => c.slug)))
      .catch(() => setCharacters([]))
  }, [load])

  // dual 测试任务是异步的：列表里有未完成任务时每 15s 刷新
  useEffect(() => {
    const pending = entries.some(
      (e) => e.dual && !['completed', 'failed', 'cancelled', 'timeout'].includes(e.dual.status),
    )
    if (!pending) return
    const timer = setInterval(() => void load(), 15_000)
    return () => clearInterval(timer)
  }, [entries, load])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    setBusy(true)
    setElapsed(0)
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000)
    try {
      const result = await api<{ poseId: string; dualTaskId: string; ratio: string }>(
        'poses/upload',
        { method: 'POST', body: data },
      )
      notify(`pose ${result.poseId} 已入 pending（${result.ratio}），dual 测试任务已提交`)
      form.reset()
      await load()
    } catch (err) {
      fail(messageOf(err))
    } finally {
      clearInterval(timer)
      setBusy(false)
    }
  }

  async function approve(entry: PendingEntry) {
    const edit = editsRef.current.get(entry.id)
    const tags = edit?.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    setBusy(true)
    try {
      const result = await api<{ target: string; manifestError: string | null }>(
        'poses/pending/approve',
        {
          method: 'POST',
          body: JSON.stringify({
            poseName: entry.poseName,
            id: entry.id,
            name: edit?.name,
            tags,
          }),
        },
      )
      if (result.manifestError) {
        fail(`已迁入 ${result.target}，但 manifest 重建失败：${result.manifestError}`)
      } else {
        notify(`已通过，迁入 ${result.target}，manifest 已重建`)
      }
      editsRef.current.delete(entry.id)
      await load()
    } catch (err) {
      fail(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  async function reject(entry: PendingEntry) {
    if (!window.confirm(`驳回 ${entry.poseName}/${entry.id}？条目会移入 _trash，可人工找回。`)) {
      return
    }
    setBusy(true)
    try {
      await api('poses/pending/reject', {
        method: 'POST',
        body: JSON.stringify({ poseName: entry.poseName, id: entry.id }),
      })
      notify(`已驳回 ${entry.poseName}/${entry.id}`)
      editsRef.current.delete(entry.id)
      await load()
    } catch (err) {
      fail(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="panel">
        <h2>上传源图 → img2pose</h2>
        <p className="muted">
          PNG 源图（纯色背景、贴身服装最佳，见 data/pose_pending/README.md 拍摄规范）。
          提交后走 BiRefNet 抠像 → depth + 骨架，条目落 pose_pending，dual 测试图异步生成，约 1–2 分钟。
        </p>
        <form onSubmit={(event) => void submit(event)}>
          <div className="grid">
            <label>
              源图（PNG）
              <input name="file" type="file" accept=".png,image/png" required />
            </label>
            <label>
              动作类目
              <select name="poseName" required defaultValue="sitting">
                {POSE_NAMES.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              画布比例
              <select name="ratio" defaultValue="auto">
                {RATIOS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              测试角色
              <select name="character" defaultValue={characters[0] ?? 'stocking_psg'}>
                {(characters.length > 0 ? characters : ['stocking_psg']).map((slug) => (
                  <option key={slug} value={slug}>
                    {slug}
                  </option>
                ))}
              </select>
            </label>
            <label>
              名称
              <input name="name" placeholder="留空自动命名" />
            </label>
            <label>
              标签（逗号分隔，附加在动作词之后）
              <input name="tags" placeholder="one knee up, ok gesture" />
            </label>
          </div>
          <label className="label-line">
            描述
            <input name="description" placeholder="姿势描述，会写进 meta" />
          </label>
          <div className="row">
            <button disabled={busy}>
              {busy ? `处理中… ${elapsed}s` : '提交处理'}
            </button>
            {busy ? (
              <span className="muted">img2pose 全链运行中，完成后条目自动落 pending</span>
            ) : null}
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="column-head">
          <h2>pose_pending 待审（{entries.length}）</h2>
          <button type="button" className="quiet" onClick={() => void load()}>
            刷新
          </button>
        </div>
        {!loaded ? (
          <p className="muted">加载中…</p>
        ) : entries.length === 0 ? (
          <p className="muted">pose_pending 是空的。</p>
        ) : (
          <ul className="stack">
            {entries.map((entry) => (
              <PendingCard
                key={`${entry.poseName}/${entry.id}`}
                entry={entry}
                busy={busy}
                edits={editsRef.current}
                onApprove={() => void approve(entry)}
                onReject={() => void reject(entry)}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

function PendingCard({
  entry,
  busy,
  edits,
  onApprove,
  onReject,
}: {
  entry: PendingEntry
  busy: boolean
  edits: Map<string, { name: string; tags: string }>
  onApprove: () => void
  onReject: () => void
}) {
  const key = `${entry.poseName}/${entry.id}`
  const edit = edits.get(key) ?? {
    name: entry.meta.name ?? '',
    tags: (entry.meta.tags ?? []).join(', '),
  }
  const setEdit = (patch: Partial<typeof edit>) => edits.set(key, { ...edit, ...patch })

  const dual = entry.dual
  const dualDone = dual !== null && ['completed', 'failed', 'cancelled', 'timeout'].includes(dual.status)

  return (
    <li className="panel">
      <div className="column-head">
        <h3 className="mono">
          {entry.poseName}/{entry.id}
        </h3>
        {dual ? (
          <span className="muted">
            dual 测试：
            <Link href={`/tasks/${dual.taskId}`}>{dual.status}</Link>
          </span>
        ) : (
          <span className="muted">无 dual 测试记录</span>
        )}
      </div>
      <div className="file-grid">
        {(['source', 'skeleton', 'depth', 'depth_preview'] as const)
          .filter((name) => entry.fileUrls[name] !== undefined)
          .map((name) => (
            <a
              key={name}
              href={runnerHref(entry.fileUrls[name])}
              target="_blank"
              rel="noreferrer"
            >
              <img src={runnerHref(entry.fileUrls[name])} alt={`${name}`} loading="lazy" />
              <span>{name}</span>
            </a>
          ))}
        {dual?.image && dualDone && dual.status === 'completed' ? (
          <a href={fileView(dual.taskId, dual.image)} target="_blank" rel="noreferrer">
            <img src={fileView(dual.taskId, dual.image)} alt="dual test" loading="lazy" />
            <span>dual 测试图</span>
          </a>
        ) : null}
      </div>
      <div className="grid">
        <label>
          名称
          <input
            defaultValue={edit.name}
            onChange={(event) => setEdit({ name: event.target.value })}
          />
        </label>
        <label>
          标签（通过时生效）
          <input
            defaultValue={edit.tags}
            onChange={(event) => setEdit({ tags: event.target.value })}
          />
        </label>
      </div>
      <p className="muted">
        {entry.meta.description || '（无描述）'} · ratio {entry.meta.ratio ?? '—'} · canvas{' '}
        {(entry.meta.canvases ?? []).join(' / ') || '—'} · {entry.meta.source ?? 'img2pose'}
      </p>
      <div className="row">
        <button disabled={busy} onClick={onApprove}>
          通过（迁入 pose 库）
        </button>
        <button type="button" className="quiet" disabled={busy} onClick={onReject}>
          驳回
        </button>
      </div>
    </li>
  )
}

// runner 相对路径（/poses/...）→ web 代理路径
function runnerHref(path: string): string {
  return `/api/runner${path}`
}

// dual 任务产物走 tasks 文件端点（output/ 相对 input 根）
function fileView(taskId: string, path: string): string {
  return `/api/runner/tasks/${taskId}/files/${path}`
}
