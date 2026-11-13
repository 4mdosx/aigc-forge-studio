'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { Dialog } from '@/components/dialog'
import { PromptChat } from '@/components/prompt-chat'
import { api } from '@/lib/api'
import type { Task, Work, Workflow } from '@/lib/types'

type FieldType = 'string' | 'seed' | 'image'

interface FieldDraft {
  key: string
  type: FieldType
}

const starter: FieldDraft[] = [
  { key: 'text', type: 'string' },
  { key: 'seed', type: 'seed' },
]

export function HomeBoard() {
  const [works, setWorks] = useState<Work[]>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Work | null>(null)
  const [chatOpen, setChatOpen] = useState(false)

  async function load() {
    const [library, catalog] = await Promise.all([
      api<{ workflows: Workflow[] }>('workflows'),
      api<{ works: Work[] }>('works'),
    ])
    setWorks(catalog.works)
    setWorkflows(library.workflows)
  }

  useEffect(() => {
    load().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    )
  }, [])

  useEffect(() => {
    let stop = false
    async function poll() {
      try {
        const body = await api<{ tasks: Task[] }>('tasks')
        if (!stop) setTasks(body.tasks)
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 2000)
    return () => {
      stop = true
      window.clearInterval(timer)
    }
  }, [])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const linked = new Set(works.flatMap((work) => work.workflows.map((item) => item.name)))
  const loose = workflows.filter((item) => !linked.has(item.name))

  return (
    <>
      {notice ? <div className="note">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}
      <div className="board">
        <section className="column">
          <h2>进行中</h2>
          {tasks.length === 0 ? (
            <p className="muted">没有正在进行的任务。</p>
          ) : (
            <ul className="stack">
              {tasks.map((task) => (
                <li key={task.id}>
                  <Link href={`/tasks/${task.id}`}>{task.task}</Link>
                  <span className={`status ${task.status}`}>{task.status}</span>
                  <span className="muted">
                    {[task.workName, task.workflowName].filter(Boolean).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="column">
          <div className="column-head">
            <h2>Work</h2>
            <button type="button" onClick={() => setCreating(true)}>
              新建
            </button>
          </div>
          {works.length === 0 && loose.length === 0 ? (
            <p className="muted">还没有 Work。</p>
          ) : (
            <ul className="stack">
              {works.map((work) => (
                <li key={work.id}>
                  <div className="item-line">
                    <Link href={`/works/${encodeURIComponent(work.name)}`}>{work.name}</Link>
                    <button type="button" className="quiet" onClick={() => setEditing(work)}>
                      编辑
                    </button>
                  </div>
                  <span className="muted">{Object.keys(work.semantic.inputs).join(', ')}</span>
                  {work.workflows.length === 0 ? (
                    <span className="muted">还没有 workflow</span>
                  ) : (
                    <ul>
                      {work.workflows.map((item) => (
                        <li key={item.id}>
                          <Link href={`/workflows/${encodeURIComponent(item.name)}`}>
                            {item.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
              {loose.map((item) => (
                <li key={item.id}>
                  <Link href={`/workflows/${encodeURIComponent(item.name)}`}>{item.name}</Link>
                  <span className="muted">未挂到 Work</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="column" aria-label="留空" />
      </div>
      <WorkDialog
        open={creating}
        title="新建 Work"
        work={null}
        busy={busy}
        onClose={() => setCreating(false)}
        onSave={(name, fields) =>
          run(async () => {
            await api('works', {
              method: 'POST',
              body: JSON.stringify({ name, semantic: { inputs: inputsOf(fields) } }),
            })
            setCreating(false)
            setNotice(`已建立 ${name}`)
          })
        }
      />
      <WorkDialog
        open={editing !== null}
        title={editing ? `编辑 ${editing.name}` : '编辑 Work'}
        work={editing}
        busy={busy}
        onClose={() => setEditing(null)}
        onSave={(name, fields) =>
          run(async () => {
            await api(`works/${encodeURIComponent(name)}/semantic`, {
              method: 'POST',
              body: JSON.stringify({ semantic: { inputs: inputsOf(fields) } }),
            })
            setEditing(null)
            setNotice(`已保存 ${name}`)
          })
        }
      />
      {chatOpen ? (
        <section className="chat-panel">
          <div className="column-head">
            <h2>提示词</h2>
            <button type="button" className="quiet" onClick={() => setChatOpen(false)}>
              关闭
            </button>
          </div>
          <PromptChat />
        </section>
      ) : null}
      <button type="button" className="chat-fab" onClick={() => setChatOpen((open) => !open)}>
        对话
      </button>
    </>
  )
}

function WorkDialog({
  open,
  title,
  work,
  busy,
  onClose,
  onSave,
}: {
  open: boolean
  title: string
  work: Work | null
  busy: boolean
  onClose: () => void
  onSave: (name: string, fields: FieldDraft[]) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [fields, setFields] = useState<FieldDraft[]>(starter)
  useEffect(() => {
    if (!open) return
    setName(work?.name ?? '')
    setFields(
      work
        ? Object.entries(work.semantic.inputs).map(([key, value]) => ({
            key,
            type: value.type,
          }))
        : starter.map((field) => ({ ...field })),
    )
  }, [open, work])
  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <label>
        名称
        <input
          value={name}
          disabled={work !== null}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <h3>语义字段</h3>
      <FieldTable fields={fields} onChange={setFields} />
      <div className="row">
        <button
          type="button"
          disabled={busy || name.trim() === ''}
          onClick={() => void onSave(name.trim(), fields)}
        >
          保存
        </button>
      </div>
    </Dialog>
  )
}

function FieldTable({
  fields,
  onChange,
}: {
  fields: FieldDraft[]
  onChange: (fields: FieldDraft[]) => void
}) {
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>字段</th>
            <th>类型</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field, index) => (
            <tr key={index}>
              <td>
                <input
                  value={field.key}
                  onChange={(event) =>
                    onChange(
                      fields.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, key: event.target.value } : item,
                      ),
                    )
                  }
                />
              </td>
              <td>
                <select
                  value={field.type}
                  onChange={(event) =>
                    onChange(
                      fields.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, type: event.target.value as FieldType }
                          : item,
                      ),
                    )
                  }
                >
                  <option value="string">string</option>
                  <option value="seed">seed</option>
                  <option value="image">image</option>
                </select>
              </td>
              <td>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => onChange(fields.filter((_, itemIndex) => itemIndex !== index))}
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button
          type="button"
          className="quiet"
          onClick={() => onChange([...fields, { key: '', type: 'string' }])}
        >
          加字段
        </button>
      </div>
    </>
  )
}

function inputsOf(fields: FieldDraft[]): Record<string, { type: FieldType }> {
  const inputs: Record<string, { type: FieldType }> = {}
  for (const field of fields) {
    const key = field.key.trim()
    if (!key) throw new Error('字段名不能为空')
    if (inputs[key]) throw new Error(`字段 ${key} 重复`)
    inputs[key] = { type: field.type }
  }
  if (Object.keys(inputs).length === 0) throw new Error('至少要有一个字段')
  return inputs
}
