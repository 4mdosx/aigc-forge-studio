'use client'

import { MessageSquare, Pencil, Plus, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Dialog } from '@/components/dialog'
import { PromptChat } from '@/components/prompt-chat'
import { TaskDock } from '@/components/task-dock'
import { WorkDetail } from '@/components/work-detail'
import { api } from '@/lib/api'
import { fail, messageOf, notify, tell } from '@/lib/notify'
import { terminal, type Task, type Work } from '@/lib/types'

type FieldType = 'string' | 'seed' | 'image'

interface FieldDraft {
  key: string
  type: FieldType
}

const starter: FieldDraft[] = [
  { key: 'text', type: 'string' },
  { key: 'seed', type: 'seed' },
]

export function WorkBoard({ initialWork = null }: { initialWork?: string | null }) {
  const router = useRouter()
  const [works, setWorks] = useState<Work[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Work | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(initialWork)
  const [detailEpoch, setDetailEpoch] = useState(0)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const freshTasks = useRef<Task[]>([])
  const knownTasks = useRef<Map<string, Task>>(new Map())
  const tasksReady = useRef(false)
  const pollError = useRef('')
  const fillRef = useRef<((text: string) => void) | null>(null)
  const bindFill = useCallback((fill: ((text: string) => void) | null) => {
    fillRef.current = fill
  }, [])

  async function load() {
    const catalog = await api<{ works: Work[] }>('works')
    setWorks(catalog.works)
  }

  useEffect(() => {
    load().catch((err: unknown) => fail(messageOf(err)))
  }, [])

  useEffect(() => {
    setSelected(initialWork)
  }, [initialWork])

  function choose(name: string) {
    setSelected(name)
    if (name === initialWork) return
    router.replace(`/library?work=${encodeURIComponent(name)}`, { scroll: false })
  }

  useEffect(() => {
    let stop = false
    async function poll() {
      try {
        const body = await api<{ tasks: Task[] }>('tasks')
        if (stop) return
        pollError.current = ''
        const listed = new Map(body.tasks.map((task) => [task.id, task]))
        const extras = freshTasks.current.filter((task) => !listed.has(task.id))
        const visible = [...extras, ...body.tasks]
        if (tasksReady.current) {
          for (const [id, task] of knownTasks.current) {
            if (listed.has(id) || extras.some((item) => item.id === id)) continue
            const label = taskLabel(task)
            void api<Task>(`tasks/${id}`)
              .then((done) => {
                if (stop || !terminal.has(done.status)) return
                const text = outcomeText(label, done)
                if (done.status === 'failed' || done.status === 'timeout') fail(text)
                else if (done.status === 'cancelled') tell(text)
                else notify(text)
              })
              .catch(() => undefined)
          }
        }
        tasksReady.current = true
        knownTasks.current = new Map(visible.map((task) => [task.id, task]))
        setTasks(visible)
      } catch (err) {
        if (stop) return
        const message = messageOf(err)
        if (pollError.current === message) return
        pollError.current = message
        fail(message)
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
    try {
      await action()
      await load()
    } catch (err) {
      fail(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  function applyPrompt(text: string) {
    if (!fillRef.current) {
      fail('先选择一个 Work')
      return
    }
    fillRef.current(text)
  }

  function toggleTasks() {
    setChatOpen(false)
    if (!tasksOpen && selectedTaskId === null && tasks[0]) setSelectedTaskId(tasks[0].id)
    setTasksOpen((open) => !open)
  }

  function toggleChat() {
    setTasksOpen(false)
    setChatOpen((open) => !open)
  }

  function queued(task: Task) {
    freshTasks.current = [task, ...freshTasks.current.filter((item) => item.id !== task.id)]
    window.setTimeout(() => {
      freshTasks.current = freshTasks.current.filter((item) => item.id !== task.id)
    }, 4000)
    setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)])
    setSelectedTaskId(task.id)
    setTasksOpen(true)
    setChatOpen(false)
  }

  return (
    <>
      <div className="work-board">
        <div className="board">
        <section className="column">
          <div className="column-head">
            <h2>Work</h2>
            <button type="button" onClick={() => setCreating(true)}>
              <Plus size={15} />
              新建
            </button>
          </div>
          {works.length === 0 ? (
            <p className="muted">还没有 Work。</p>
          ) : (
            <ul className="stack rows">
              {works.map((work) => (
                <li key={work.id} className={selected === work.name ? 'picked' : undefined}>
                  <div className="item-copy">
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => choose(work.name)}
                    >
                      {work.name}
                    </button>
                    <span className="muted">{Object.keys(work.semantic.inputs).join(', ')}</span>
                  </div>
                  <button type="button" className="quiet" onClick={() => setEditing(work)}>
                    <Pencil size={14} />
                    编辑
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {selected ? (
          <WorkDetail
            key={`${selected}:${detailEpoch}`}
            name={selected}
            onQueued={queued}
            onBindFill={bindFill}
          />
        ) : (
          <>
            <section className="column">
              <h2>详情</h2>
              <p className="muted">选择一个 Work。</p>
            </section>
            <section className="column">
              <h2>出图</h2>
              <p className="muted">选择一个 Work 后在这里出图。</p>
            </section>
          </>
        )}
        </div>
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
            choose(name)
            notify(`已建立 ${name}`)
          })
        }
      />
      <WorkDialog
        open={editing !== null}
        title={editing ? `编辑 ${editing.name}` : '编辑 Work'}
        work={editing}
        busy={busy}
        onClose={() => setEditing(null)}
        onSave={(name, fields) => {
          const current = editing
          if (!current) return Promise.resolve()
          return run(async () => {
            const saved = await api<{ name: string }>(
              `works/${encodeURIComponent(current.name)}/semantic`,
              {
                method: 'POST',
                body: JSON.stringify({
                  name,
                  semantic: { inputs: inputsOf(fields) },
                }),
              },
            )
            setEditing(null)
            if (current.name === selected) {
              if (saved.name === selected) setDetailEpoch((epoch) => epoch + 1)
              else choose(saved.name)
            }
            notify(`已保存 ${saved.name}`)
          })
        }}
      />
      {chatOpen ? (
        <section className="float-panel chat-panel">
          <div className="column-head">
            <h2>提示词</h2>
            <button type="button" className="quiet icon" aria-label="关闭" title="关闭" onClick={() => setChatOpen(false)}>
              <X size={16} />
            </button>
          </div>
          <PromptChat onUsePrompt={applyPrompt} />
        </section>
      ) : null}
      <div className="dock">
        <TaskDock
          tasks={tasks}
          open={tasksOpen}
          selectedId={selectedTaskId}
          onToggle={toggleTasks}
          onSelect={setSelectedTaskId}
        />
        <button
          type="button"
          className={chatOpen ? 'pressed' : undefined}
          aria-expanded={chatOpen}
          onClick={toggleChat}
        >
          <MessageSquare size={16} />
          对话
        </button>
      </div>
    </>
  )
}

function taskLabel(task: Task): string {
  return [task.workName, task.workflowName].filter(Boolean).join(' · ') || task.task
}

function outcomeText(label: string, task: Task): string {
  const name =
    task.status === 'completed'
      ? '已完成'
      : task.status === 'failed'
        ? '失败'
        : task.status === 'timeout'
          ? '超时'
          : task.status === 'cancelled'
            ? '已取消'
            : task.status
  const error = task.error?.split('\n')[0]?.trim()
  const brief = error && error.length > 160 ? `${error.slice(0, 160)}…` : error
  return brief ? `${label} ${name}：${brief}` : `${label} ${name}`
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
    <Dialog
      open={open}
      title={work ? `编辑 ${name.trim() || work.name}` : title}
      onClose={onClose}
    >
      <label>
        名称
        <input value={name} onChange={(event) => setName(event.target.value)} />
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
