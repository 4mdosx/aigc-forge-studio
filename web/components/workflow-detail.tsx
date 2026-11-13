'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { Dialog } from '@/components/dialog'
import { api } from '@/lib/api'
import type { Adapter, AdapterBinding, Revision, Task, Workflow } from '@/lib/types'

type FieldType = 'string' | 'seed' | 'image'

interface FieldDraft {
  key: string
  type: FieldType
}

interface InputDraft {
  key: string
  classType: string
  name: string
  input: string
}

interface OutputDraft {
  key: string
  classType: string
  name: string
}

export function WorkflowDetail({ name }: { name: string }) {
  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [fields, setFields] = useState<FieldDraft[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [taskRevision, setTaskRevision] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [branch, setBranch] = useState('')
  const [message, setMessage] = useState('')
  const [adapterVersion, setAdapterVersion] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const encoded = encodeURIComponent(name)

  async function load() {
    const listed = await api<{ workflows: Workflow[] }>('workflows')
    const current = listed.workflows.find((item) => item.name === name) ?? null
    setWorkflow(current)
    if (current?.workName) {
      const work = await api<{ semantic: { inputs: Record<string, { type: FieldType }> } }>(
        `works/${encodeURIComponent(current.workName)}`,
      )
      setFields(
        Object.entries(work.semantic.inputs).map(([key, field]) => ({
          key,
          type: field.type,
        })),
      )
    } else {
      setFields([])
    }
    const history = await api<{ revisions: Revision[] }>(`workflows/${encoded}/revisions`)
    setRevisions(history.revisions)
    const head = history.revisions.find((item) => item.head) ?? history.revisions.at(-1) ?? null
    if (head) {
      setTaskRevision(head.id)
      const body = await api<{ tasks: Task[] }>(`revisions/${head.id}/tasks`)
      setTasks(body.tasks)
    } else {
      setTaskRevision('')
      setTasks([])
    }
  }

  useEffect(() => {
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
    // The first load uses the route name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

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

  const editing = revisions.find((item) => item.version === adapterVersion) ?? null

  return (
    <>
      {notice ? <div className="note">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}
      <section className="panel">
        <h2>{name}</h2>
        <p>
          当前分支 {workflow?.currentBranch ?? '…'} · 图{' '}
          <span className="mono">{workflow?.comfyPath}</span>
          {workflow?.workName ? (
            <>
              {' '}
              · Work{' '}
              <Link href={`/works/${encodeURIComponent(workflow.workName)}`}>{workflow.workName}</Link>
            </>
          ) : (
            ' · 尚未挂到 Work'
          )}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              const created = await api<{ version: number }>(`workflows/${encoded}/commit`, {
                method: 'POST',
                body: JSON.stringify(message.trim() ? { message: message.trim() } : {}),
              })
              setMessage('')
              setNotice(`已从 ComfyUI 建立 v${created.version}`)
            })
          }}
        >
          <div className="row">
            <label>
              版本说明
              <input
                value={message}
                placeholder="这一版改了什么"
                onChange={(event) => setMessage(event.target.value)}
              />
            </label>
            <button disabled={busy}>新建版本</button>
          </div>
          <p className="note">从 ComfyUI 里这张图的当前内容收一个新版本。已有版本不会被改掉。</p>
        </form>
      </section>
      <section className="panel">
        <h2>版本</h2>
        {revisions.length === 0 ? (
          <p className="muted">还没有版本。</p>
        ) : (
          <ul className="stack">
            {revisions.map((revision) => (
              <VersionItem
                key={revision.id}
                revision={revision}
                busy={busy}
                onSync={() =>
                  void run(async () => {
                    await api(`workflows/${encoded}/revisions/${revision.version}/checkout`, {
                      method: 'POST',
                    })
                    setNotice(`已把 v${revision.version} 同步到 ComfyUI`)
                  })
                }
                onAdapter={() => setAdapterVersion(revision.version)}
                onMessage={(text) =>
                  run(async () => {
                    await api(`workflows/${encoded}/revisions/${revision.version}/message`, {
                      method: 'POST',
                      body: JSON.stringify({ message: text }),
                    })
                    setNotice(`已保存 v${revision.version} 的说明`)
                  })
                }
              />
            ))}
          </ul>
        )}
      </section>
      <section className="panel">
        <h2>分支</h2>
        <div className="row">
          <label>
            分支
            <input value={branch} onChange={(event) => setBranch(event.target.value)} />
          </label>
          <button
            className="quiet"
            disabled={busy || branch === ''}
            onClick={() =>
              void run(() =>
                api(`workflows/${encoded}/switch`, {
                  method: 'POST',
                  body: JSON.stringify({ branch }),
                }).then(() => undefined),
              )
            }
          >
            切换
          </button>
          <button
            className="quiet"
            disabled={busy || branch === ''}
            onClick={() =>
              void run(async () => {
                await api(`workflows/${encoded}/branches`, {
                  method: 'POST',
                  body: JSON.stringify({ name: branch }),
                })
              })
            }
          >
            新建
          </button>
        </div>
        <h2>这个版本的任务</h2>
        <p className="muted">
          {revisions.find((item) => item.id === taskRevision)
            ? `v${revisions.find((item) => item.id === taskRevision)?.version}`
            : '还没有版本'}
        </p>
        <table>
          <thead>
            <tr>
              <th>任务</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 ? (
              <tr>
                <td colSpan={2}>没有任务。</td>
              </tr>
            ) : (
              tasks.map((task) => (
                <tr key={task.id}>
                  <td>
                    <Link href={`/tasks/${task.id}`}>{task.task}</Link>
                  </td>
                  <td>
                    <span className={`status ${task.status}`}>{task.status}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
      <AdapterDialog
        open={editing !== null}
        workflow={workflow}
        revision={editing}
        fields={fields}
        busy={busy}
        onClose={() => setAdapterVersion(null)}
        onSave={(adapter) =>
          run(async () => {
            await api(`workflows/${encoded}/adapter`, {
              method: 'POST',
              body: JSON.stringify({ adapter }),
            })
            setAdapterVersion(null)
            setNotice('已保存 Adapter，没有产生新版本')
          })
        }
      />
    </>
  )
}

function VersionItem({
  revision,
  busy,
  onSync,
  onAdapter,
  onMessage,
}: {
  revision: Revision
  busy: boolean
  onSync: () => void
  onAdapter: () => void
  onMessage: (message: string) => Promise<void>
}) {
  const [text, setText] = useState(revision.message ?? '')
  useEffect(() => {
    setText(revision.message ?? '')
  }, [revision.message])
  const dirty = text.trim() !== (revision.message ?? '')
  return (
    <li>
      <div className="item-line">
        <strong>
          v{revision.version}
          {revision.main ? ' · main' : ''}
          {revision.head ? ' · 当前头' : ''}
        </strong>
        <span className={`status ${adapterTone(revision.adapter?.status)}`}>
          {adapterLabel(revision.adapter)}
        </span>
      </div>
      <div className="row">
        <label>
          版本说明
          <input value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <button type="button" className="quiet" disabled={busy || !dirty} onClick={() => void onMessage(text.trim())}>
          保存说明
        </button>
      </div>
      {revision.adapter?.error ? <p className="error">{revision.adapter.error}</p> : null}
      <div className="row">
        <button type="button" className="quiet" disabled={busy} onClick={onSync}>
          同步到 ComfyUI
        </button>
        <button type="button" className="quiet" onClick={onAdapter}>
          {revision.adapter?.status === 'ready' ? '查看 Adapter' : '编辑 Adapter'}
        </button>
      </div>
    </li>
  )
}

function AdapterDialog({
  open,
  workflow,
  revision,
  fields,
  busy,
  onClose,
  onSave,
}: {
  open: boolean
  workflow: Workflow | null
  revision: Revision | null
  fields: FieldDraft[]
  busy: boolean
  onClose: () => void
  onSave: (adapter: Adapter) => Promise<void>
}) {
  const source = workflow?.adapter ?? revision?.suggestedAdapter ?? null
  const [inputs, setInputs] = useState<InputDraft[]>([])
  const [outputs, setOutputs] = useState<OutputDraft[]>([])

  useEffect(() => {
    if (!open) return
    setInputs(inputRows(source, fields))
    setOutputs(outputRows(source))
  }, [open, source, fields])

  return (
    <Dialog open={open} title={`v${revision?.version ?? ''} 的 Adapter`} onClose={onClose}>
      <p>
        映射保存在这张 workflow 上，保存不会产生新版本。这一版目前是
        {adapterLabel(revision?.adapter)}。
      </p>
      <table>
        <thead>
          <tr>
            <th>字段</th>
            <th>class_type</th>
            <th>节点标题</th>
            <th>输入</th>
            {fields.length === 0 ? <th></th> : null}
          </tr>
        </thead>
        <tbody>
          {inputs.map((row, index) => (
            <tr key={`${row.key}-${index}`}>
              <td>
                {fields.length > 0 ? (
                  row.key
                ) : (
                  <input
                    value={row.key}
                    onChange={(event) =>
                      setInputs((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, key: event.target.value } : item,
                        ),
                      )
                    }
                  />
                )}
              </td>
              <td>
                <input
                  value={row.classType}
                  onChange={(event) =>
                    setInputs((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, classType: event.target.value } : item,
                      ),
                    )
                  }
                />
              </td>
              <td>
                <input
                  value={row.name}
                  placeholder="可空"
                  onChange={(event) =>
                    setInputs((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, name: event.target.value } : item,
                      ),
                    )
                  }
                />
              </td>
              <td>
                <input
                  value={row.input}
                  disabled={fields.find((field) => field.key === row.key)?.type === 'seed'}
                  onChange={(event) =>
                    setInputs((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, input: event.target.value } : item,
                      ),
                    )
                  }
                />
              </td>
              {fields.length === 0 ? (
                <td>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() =>
                      setInputs((current) => current.filter((_, itemIndex) => itemIndex !== index))
                    }
                  >
                    删除
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {fields.length === 0 ? (
        <div className="row">
          <button
            type="button"
            className="quiet"
            onClick={() =>
              setInputs((current) => [...current, { key: '', classType: '', name: '', input: '' }])
            }
          >
            加字段
          </button>
        </div>
      ) : null}
      <h3>输出</h3>
      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>class_type</th>
            <th>节点标题</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {outputs.map((row, index) => (
            <tr key={index}>
              <td>
                <input
                  value={row.key}
                  onChange={(event) =>
                    setOutputs((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, key: event.target.value } : item,
                      ),
                    )
                  }
                />
              </td>
              <td>
                <input
                  value={row.classType}
                  onChange={(event) =>
                    setOutputs((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, classType: event.target.value } : item,
                      ),
                    )
                  }
                />
              </td>
              <td>
                <input
                  value={row.name}
                  onChange={(event) =>
                    setOutputs((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, name: event.target.value } : item,
                      ),
                    )
                  }
                />
              </td>
              <td>
                <button
                  type="button"
                  className="quiet"
                  onClick={() =>
                    setOutputs((current) => current.filter((_, itemIndex) => itemIndex !== index))
                  }
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
          onClick={() => setOutputs((current) => [...current, { key: 'images', classType: '', name: '' }])}
        >
          加输出
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const adapter: Adapter = { inputs: {}, outputs: {} }
            for (const row of inputs) {
              const key = row.key.trim()
              if (!key) continue
              const field = fields.find((item) => item.key === key)
              adapter.inputs[key] = binding(row, field?.type === 'image')
            }
            for (const row of outputs) {
              if (!row.key.trim()) continue
              adapter.outputs[row.key.trim()] = {
                class_type: row.classType.trim(),
                ...(row.name.trim() ? { name: row.name.trim() } : {}),
              }
            }
            void onSave(adapter)
          }}
        >
          保存
        </button>
      </div>
    </Dialog>
  )
}

function inputRows(adapter: Adapter | null, fields: FieldDraft[]): InputDraft[] {
  if (fields.length > 0) {
    return fields.map((field) => {
      const row = adapter?.inputs[field.key]
      return {
        key: field.key,
        classType: row?.class_type ?? '',
        name: row?.name ?? '',
        input: field.type === 'seed' ? 'seed' : (row?.input ?? ''),
      }
    })
  }
  return Object.entries(adapter?.inputs ?? {}).map(([key, row]) => ({
    key,
    classType: row.class_type,
    name: row.name ?? '',
    input: row.input ?? '',
  }))
}

function outputRows(adapter: Adapter | null): OutputDraft[] {
  return Object.entries(adapter?.outputs ?? {}).map(([key, row]) => ({
    key,
    classType: row.class_type,
    name: row.name ?? '',
  }))
}

function binding(row: InputDraft, upload: boolean): AdapterBinding {
  return {
    class_type: row.classType.trim(),
    input: row.input.trim(),
    ...(row.name.trim() ? { name: row.name.trim() } : {}),
    ...(upload ? { upload: true } : {}),
  }
}

function adapterLabel(
  adapter: { status: 'missing' | 'ready' | 'mismatch'; error?: string } | undefined,
): string {
  if (!adapter) return '未选择版本'
  if (adapter.status === 'ready') return '可用于这一版'
  if (adapter.status === 'mismatch') return '对不上这一版'
  return '未设置'
}

function adapterTone(status: 'missing' | 'ready' | 'mismatch' | undefined): string {
  if (status === 'ready') return 'completed'
  if (status === 'mismatch') return 'failed'
  return 'pending'
}
