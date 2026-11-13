'use client'

import { useEffect, useRef, useState } from 'react'

import { Dialog } from '@/components/dialog'
import { api } from '@/lib/api'
import type { Adapter, Revision, Task, Work, Workflow } from '@/lib/types'

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
  upload: boolean
}

interface OutputDraft {
  key: string
  classType: string
  name: string
}

interface GraphNode {
  id: number
  type: string
  title: string
  x: number
  y: number
}

interface GraphView {
  version: number
  message: string | null
  nodes: GraphNode[]
  links: Array<{ from: number; to: number }>
}

function fieldsFrom(work: Work | null): FieldDraft[] {
  if (!work) return []
  return Object.entries(work.semantic.inputs).map(([key, field]) => ({
    key,
    type: field.type,
  }))
}

function valuesFor(
  fields: FieldDraft[],
  previous: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {}
  for (const field of fields) {
    if (previous[field.key] !== undefined) next[field.key] = previous[field.key] ?? ''
    else if (field.type === 'seed') next[field.key] = 'random'
    else if (field.type === 'image') next[field.key] = 'jobs/image.png'
    else next[field.key] = ''
  }
  return next
}

function inputDrafts(adapter: Adapter | null, fields: FieldDraft[]): InputDraft[] {
  return fields.map((field) => {
    const binding = adapter?.inputs[field.key]
    return {
      key: field.key,
      classType: binding?.class_type ?? '',
      name: binding?.name ?? '',
      input: field.type === 'seed' ? 'seed' : (binding?.input ?? ''),
      upload: field.type === 'image' ? true : Boolean(binding?.upload),
    }
  })
}

function outputDrafts(adapter: Adapter | null): OutputDraft[] {
  return Object.entries(adapter?.outputs ?? {}).map(([key, binding]) => ({
    key,
    classType: binding.class_type,
    name: binding.name ?? '',
  }))
}

export function WorkDetail({ name }: { name: string }) {
  const [work, setWork] = useState<Work | null>(null)
  const [library, setLibrary] = useState<Workflow[]>([])
  const [runWorkflow, setRunWorkflow] = useState('')
  const [attachName, setAttachName] = useState('')
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [version, setVersion] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [fields, setFields] = useState<FieldDraft[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [adapterOpen, setAdapterOpen] = useState(false)
  const [graphWorkflow, setGraphWorkflow] = useState('')
  const versionWorkflow = useRef('')
  const encoded = encodeURIComponent(name)

  async function load() {
    const [current, listed] = await Promise.all([
      api<Work>(`works/${encoded}`),
      api<{ workflows: Workflow[] }>('workflows'),
    ])
    setWork(current)
    setLibrary(listed.workflows)
    const nextFields = fieldsFrom(current)
    setFields(nextFields)
    setValues((previous) => valuesFor(nextFields, previous))
    setRunWorkflow((selected) =>
      current.workflows.some((item) => item.name === selected)
        ? selected
        : (current.workflows[0]?.name ?? ''),
    )
  }

  useEffect(() => {
    load().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    )
    // Reload when the work route changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

  useEffect(() => {
    if (!runWorkflow) {
      setRevisions([])
      setVersion('')
      return
    }
    const switching = versionWorkflow.current !== runWorkflow
    if (switching) {
      setRevisions([])
      setVersion('')
    }
    let stop = false
    api<{ revisions: Revision[] }>(
      `workflows/${encodeURIComponent(runWorkflow)}/revisions`,
    )
      .then((body) => {
        if (stop) return
        setRevisions(body.revisions)
        versionWorkflow.current = runWorkflow
        const stillThere = body.revisions.some(
          (item) => String(item.version) === version,
        )
        if (!switching && stillThere) return
        const main = body.revisions.find((item) => item.main)
        setVersion(String(main?.version ?? body.revisions.at(-1)?.version ?? ''))
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
    return () => {
      stop = true
    }
  }, [runWorkflow, work])

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

  const selected = revisions.find((item) => String(item.version) === version)
  const workflow = library.find((item) => item.name === runWorkflow) ?? null
  const unlinked = library.filter((item) => item.workId === null)
  const adapterStatus = selected?.adapter

  return (
    <>
      {notice ? <div className="note">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}
      <section className="panel">
        <h2>出图</h2>
        <p className="note">
          用 Runner 里选中的版本构造 /prompt，不写回 ComfyUI。版本留在 main 时就是这张图的 main。
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const payload: Record<string, unknown> = {}
            for (const field of fields) {
              const raw = values[field.key] ?? ''
              if (field.type === 'seed' && /^\d+$/.test(raw)) payload[field.key] = Number(raw)
              else payload[field.key] = raw
            }
            void run(async () => {
              const task = await api<Task>('tasks', {
                method: 'POST',
                body: JSON.stringify({
                  task: 'run',
                  workName: name,
                  workflowName: runWorkflow,
                  ...(version ? { version: Number(version) } : {}),
                  payload,
                }),
              })
              window.location.href = `/tasks/${task.id}`
            })
          }}
        >
          <div className="grid">
            <label>
              workflow
              <select
                value={runWorkflow}
                onChange={(event) => setRunWorkflow(event.target.value)}
              >
                <option value="">选择</option>
                {(work?.workflows ?? []).map((item) => (
                  <option key={item.id} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              版本
              <select value={version} onChange={(event) => setVersion(event.target.value)}>
                <option value="">选择</option>
                {revisions.map((item) => (
                  <option key={item.id} value={item.version}>
                    v{item.version}
                    {item.main ? ' · main' : ''}
                    {item.message ? ` · ${item.message}` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <span>
              Adapter{' '}
              <span className={`status ${adapterTone(adapterStatus?.status)}`}>
                {adapterLabel(adapterStatus)}
              </span>
            </span>
            <button
              type="button"
              className="quiet"
              disabled={!runWorkflow || !selected}
              onClick={() => setAdapterOpen(true)}
            >
              {adapterStatus?.status === 'ready' ? '查看 Adapter' : '设置 Adapter'}
            </button>
          </div>
          {adapterStatus?.error ? <p className="error">{adapterStatus.error}</p> : null}
          <div className="grid">
            {fields.map((field) => (
              <label key={field.key}>
                {field.key}
                <input
                  value={values[field.key] ?? ''}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.key]: event.target.value,
                    }))
                  }
                />
              </label>
            ))}
          </div>
          <div className="row">
            <button
              disabled={
                busy || runWorkflow === '' || version === '' || adapterStatus?.status !== 'ready'
              }
            >
              加入队列
            </button>
          </div>
        </form>
      </section>
      <section className="panel">
        <h2>语义字段</h2>
        <p>这些字段决定出图参数。Adapter 按同名字段映射到 workflow 节点。</p>
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
                      setFields((current) =>
                        current.map((item, itemIndex) =>
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
                      setFields((current) =>
                        current.map((item, itemIndex) =>
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
                    onClick={() =>
                      setFields((current) => current.filter((_, itemIndex) => itemIndex !== index))
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
            onClick={() => setFields((current) => [...current, { key: '', type: 'string' }])}
          >
            加字段
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const inputs: Record<string, { type: FieldType }> = {}
                for (const field of fields) {
                  if (!field.key.trim()) throw new Error('字段名不能为空')
                  inputs[field.key.trim()] = { type: field.type }
                }
                await api(`works/${encoded}/semantic`, {
                  method: 'POST',
                  body: JSON.stringify({ semantic: { inputs } }),
                })
              })
            }
          >
            保存语义
          </button>
        </div>
      </section>
      <section className="panel">
        <h2>关联的 workflow</h2>
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>ComfyUI</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(work?.workflows ?? []).length === 0 ? (
              <tr>
                <td colSpan={3}>还没有挂 workflow。</td>
              </tr>
            ) : (
              work?.workflows.map((item) => (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td className="mono">{item.comfyPath}</td>
                  <td>
                    <div className="row">
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => setGraphWorkflow(item.name)}
                      >
                        版本
                      </button>
                      <button
                        type="button"
                        className="quiet"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            api(`works/${encoded}/workflows/detach`, {
                              method: 'POST',
                              body: JSON.stringify({ workflowName: item.name }),
                            }).then(() => undefined),
                          )
                        }
                      >
                        取消关联
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <div className="row">
          <label>
            挂上
            <select value={attachName} onChange={(event) => setAttachName(event.target.value)}>
              <option value="">选择 workflow</option>
              {unlinked.map((item) => (
                <option key={item.id} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={busy || attachName === ''}
            onClick={() =>
              void run(async () => {
                await api(`works/${encoded}/workflows`, {
                  method: 'POST',
                  body: JSON.stringify({ workflowName: attachName }),
                })
                setAttachName('')
              })
            }
          >
            关联
          </button>
        </div>
      </section>
      <AdapterDialog
        open={adapterOpen}
        workflow={workflow}
        fields={fields}
        busy={busy}
        onClose={() => setAdapterOpen(false)}
        onSave={(adapter) =>
          run(async () => {
            await api(`workflows/${encodeURIComponent(runWorkflow)}/adapter`, {
              method: 'POST',
              body: JSON.stringify({ adapter }),
            })
            setAdapterOpen(false)
          })
        }
      />
      <VersionDialog
        workflowName={graphWorkflow}
        busy={busy}
        onClose={() => setGraphWorkflow('')}
        onCheckout={(selectedVersion) =>
          run(async () => {
            await api(
              `workflows/${encodeURIComponent(graphWorkflow)}/revisions/${selectedVersion}/checkout`,
              { method: 'POST' },
            )
            setNotice(`已把 v${selectedVersion} 检出到 ComfyUI`)
          })
        }
      />
    </>
  )
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

function AdapterDialog({
  open,
  workflow,
  fields,
  busy,
  onClose,
  onSave,
}: {
  open: boolean
  workflow: Workflow | null
  fields: FieldDraft[]
  busy: boolean
  onClose: () => void
  onSave: (adapter: Adapter) => Promise<void>
}) {
  const source = workflow?.adapter ?? workflow?.suggestedAdapter ?? null
  const [inputs, setInputs] = useState<InputDraft[]>([])
  const [outputs, setOutputs] = useState<OutputDraft[]>([])

  useEffect(() => {
    if (!open) return
    setInputs(inputDrafts(source, fields))
    setOutputs(outputDrafts(source))
  }, [open, workflow, fields])

  return (
    <Dialog open={open} title={`${workflow?.name ?? ''} 的 Adapter`} onClose={onClose}>
      <p>映射保存在这张 workflow 上，不产生新版本。切换版本时会用这一份去对那一版的节点。</p>
      <table>
        <thead>
          <tr>
            <th>字段</th>
            <th>class_type</th>
            <th>节点标题</th>
            <th>输入</th>
          </tr>
        </thead>
        <tbody>
          {inputs.map((row, index) => (
            <tr key={row.key}>
              <td>{row.key}</td>
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
            </tr>
          ))}
        </tbody>
      </table>
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
          onClick={() =>
            setOutputs((current) => [...current, { key: 'images', classType: '', name: '' }])
          }
        >
          加输出
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const adapter: Adapter = { inputs: {}, outputs: {} }
            for (const row of inputs) {
              const field = fields.find((item) => item.key === row.key)
              adapter.inputs[row.key] = {
                class_type: row.classType.trim(),
                input: row.input.trim(),
                ...(row.name.trim() ? { name: row.name.trim() } : {}),
                ...(field?.type === 'image' ? { upload: true } : {}),
              }
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

function VersionDialog({
  workflowName,
  busy,
  onClose,
  onCheckout,
}: {
  workflowName: string
  busy: boolean
  onClose: () => void
  onCheckout: (version: number) => Promise<void>
}) {
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [version, setVersion] = useState('')
  const [graph, setGraph] = useState<GraphView | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!workflowName) return
    let stop = false
    api<{ revisions: Revision[] }>(`workflows/${encodeURIComponent(workflowName)}/revisions`)
      .then((body) => {
        if (stop) return
        setRevisions(body.revisions)
        const main = body.revisions.find((item) => item.main)
        setVersion(String(main?.version ?? body.revisions.at(-1)?.version ?? ''))
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
    return () => {
      stop = true
    }
  }, [workflowName])

  useEffect(() => {
    if (!workflowName || !version) return
    let stop = false
    api<GraphView>(
      `workflows/${encodeURIComponent(workflowName)}/revisions/${version}`,
    )
      .then((body) => {
        if (!stop) setGraph(body)
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
    return () => {
      stop = true
    }
  }, [workflowName, version])

  return (
    <Dialog open={workflowName !== ''} title={`${workflowName} 的版本`} onClose={onClose}>
      {error ? <div className="error">{error}</div> : null}
      <label>
        版本
        <select value={version} onChange={(event) => setVersion(event.target.value)}>
          {revisions.map((item) => (
            <option key={item.id} value={item.version}>
              v{item.version}
              {item.main ? ' · main' : ''}
              {item.message ? ` · ${item.message}` : ''}
            </option>
          ))}
        </select>
      </label>
      <Graph nodes={graph?.nodes ?? []} links={graph?.links ?? []} />
      <div className="row">
        <button
          type="button"
          disabled={busy || version === ''}
          onClick={() => void onCheckout(Number(version))}
        >
          检出这一版到 ComfyUI
        </button>
      </div>
    </Dialog>
  )
}

function Graph({
  nodes,
  links,
}: {
  nodes: GraphNode[]
  links: Array<{ from: number; to: number }>
}) {
  if (nodes.length === 0) return <p>这一版没有节点。</p>
  const xs = nodes.map((node) => node.x)
  const ys = nodes.map((node) => node.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)
  const scale = Math.min(640 / Math.max(maxX - minX + 180, 1), 420 / Math.max(maxY - minY + 72, 1), 1)
  const width = Math.max((maxX - minX + 180) * scale, 280)
  const height = Math.max((maxY - minY + 72) * scale, 120)
  const placed = nodes.map((node) => ({
    ...node,
    left: (node.x - minX) * scale,
    top: (node.y - minY) * scale,
  }))
  const byId = new Map(placed.map((node) => [node.id, node]))
  return (
    <div className="graph" style={{ width, height }}>
      <svg width={width} height={height}>
        {links.map((link, index) => {
          const from = byId.get(link.from)
          const to = byId.get(link.to)
          if (!from || !to) return null
          return (
            <line
              key={index}
              x1={from.left + 140}
              y1={from.top + 28}
              x2={to.left}
              y2={to.top + 28}
              stroke="#8a8175"
            />
          )
        })}
      </svg>
      {placed.map((node) => (
        <div key={node.id} className="graph-node" style={{ left: node.left, top: node.top }}>
          <strong>{node.title || node.type}</strong>
          <span>
            {node.type} · {node.id}
          </span>
        </div>
      ))}
    </div>
  )
}

