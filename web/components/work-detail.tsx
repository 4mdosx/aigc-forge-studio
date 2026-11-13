'use client'

import { useEffect, useRef, useState } from 'react'

import { Dialog } from '@/components/dialog'
import { api } from '@/lib/api'
import { fail, messageOf, notify } from '@/lib/notify'
import type { Adapter, Revision, Task, Work, WorkVersion, Workflow } from '@/lib/types'

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
  version: string
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

export function WorkDetail({
  name,
  onQueued,
  onBindFill,
}: {
  name: string
  onQueued?: (task: Task) => void
  onBindFill?: (fill: ((text: string) => void) | null) => void
}) {
  const [work, setWork] = useState<Work | null>(null)
  const [library, setLibrary] = useState<Workflow[]>([])
  const [runWorkflow, setRunWorkflow] = useState('')
  const [attachName, setAttachName] = useState('')
  const [version, setVersion] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [fields, setFields] = useState<FieldDraft[]>([])
  const [filledKey, setFilledKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [adapterOpen, setAdapterOpen] = useState(false)
  const [graphWorkflow, setGraphWorkflow] = useState('')
  const fieldsRef = useRef(fields)
  const flashTimer = useRef<number | null>(null)
  fieldsRef.current = fields
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
    setRunWorkflow((selected) => {
      const next = current.workflows.some((item) => item.name === selected)
        ? selected
        : (current.workflows[0]?.name ?? '')
      setVersion((currentVersion) => versionOf(current, next, currentVersion))
      return next
    })
  }

  useEffect(() => {
    load().catch((err: unknown) => fail(messageOf(err)))
    // Reload when the work route changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

  useEffect(() => {
    if (!onBindFill) return
    onBindFill((text) => {
      const list = fieldsRef.current
      const key =
        list.find((field) => field.key === 'text' && field.type === 'string')?.key ??
        list.find((field) => field.type === 'string')?.key
      if (!key) {
        fail('这个 Work 没有文本字段')
        return
      }
      setValues((current) => ({ ...current, [key]: text }))
      setFilledKey(key)
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
      flashTimer.current = window.setTimeout(() => {
        setFilledKey((current) => (current === key ? null : current))
      }, 1600)
      notify(`已填入 ${key}`)
      window.setTimeout(() => {
        document.getElementById(`run-${key}`)?.scrollIntoView({ block: 'nearest' })
      }, 0)
    })
    return () => {
      onBindFill(null)
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    }
  }, [onBindFill])

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

  const bound = work?.workflows ?? []
  const running = bound.find((item) => item.name === runWorkflow) ?? null
  const runVersions = running?.versions ?? []
  const selected = runVersions.find((item) => item.version === version) ?? null
  const adapterStatus = selected?.adapterStatus
  const unlinked = library.filter((item) => !bound.some((link) => link.name === item.name))
  const leadKey =
    fields.find((field) => field.key === 'text' && field.type === 'string')?.key ??
    fields.find((field) => field.type === 'string')?.key

  const runSection = (
      <section className="work-block">
        <h2>出图</h2>
        <p className="muted">只跑已挂上的版本，不写回 ComfyUI。</p>
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
                  ...(version ? { version } : {}),
                  payload,
                }),
              })
              onQueued?.(task)
              notify('已加入队列')
            })
          }}
        >
          <div className="grid">
            <label>
              workflow
              <select
                value={runWorkflow}
                onChange={(event) => {
                  const next = event.target.value
                  setRunWorkflow(next)
                  setVersion(versionOf(work, next, ''))
                }}
              >
                <option value="">选择</option>
                {bound.map((item) => (
                  <option key={item.id} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <VersionChoices
              versions={runVersions}
              value={version}
              enabled={runWorkflow !== ''}
              onChange={setVersion}
            />
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
              {selected?.borrowedFrom
                ? '记到这一版'
                : adapterStatus?.status === 'ready'
                  ? '查看 Adapter'
                  : '设置 Adapter'}
            </button>
          </div>
          {selected?.borrowedFrom ? (
            <p className="muted">这一版还没有 Adapter，正在用 {selected.borrowedFrom} 的。</p>
          ) : null}
          {adapterStatus?.error ? <p className="error">{adapterStatus.error}</p> : null}
          <div className="grid">
            {fields.map((field) => {
              const filled = filledKey === field.key
              return (
                <label key={field.key}>
                  <span className="label-line">
                    {field.key}
                    <span>{field.type}</span>
                  </span>
                  {field.type === 'string' ? (
                    <textarea
                      id={`run-${field.key}`}
                      className={`prose${field.key === leadKey ? ' lead' : ''}${filled ? ' flash' : ''}`}
                      rows={field.key === leadKey ? 5 : 3}
                      value={values[field.key] ?? ''}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }))
                      }
                    />
                  ) : (
                    <input
                      id={`run-${field.key}`}
                      className={filled ? 'flash' : undefined}
                      value={values[field.key] ?? ''}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }))
                      }
                    />
                  )}
                </label>
              )
            })}
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
  )
  const detailSection = (
    <>
      <section className="work-block">
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
                notify('已保存语义')
              })
            }
          >
            保存语义
          </button>
        </div>
      </section>
      <section className="work-block">
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
            {bound.length === 0 ? (
              <tr>
                <td colSpan={3}>还没有挂 workflow。</td>
              </tr>
            ) : (
              bound.map((item) => (
                <tr key={item.id}>
                  <td>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setGraphWorkflow(item.name)}
                    >
                      {item.name}
                    </button>
                  </td>
                  <td className="mono">{item.comfyPath}</td>
                  <td>
                    <button
                      type="button"
                      className="quiet"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api(`works/${encoded}/workflows/detach`, {
                            method: 'POST',
                            body: JSON.stringify({ workflowName: item.name }),
                          })
                          notify(`已取消关联 ${item.name}`)
                        })
                      }
                    >
                      取消关联
                    </button>
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
                notify(`已关联 ${attachName}`)
              })
            }
          >
            关联
          </button>
        </div>
      </section>
    </>
  )
  const dialogs = (
    <>
      <AdapterDialog
        open={adapterOpen}
        title={`${runWorkflow} ${version}`}
        borrowedFrom={selected?.borrowedFrom ?? null}
        adapter={selected?.adapter ?? null}
        suggested={selected?.suggestedAdapter ?? null}
        fields={fields}
        busy={busy}
        onClose={() => setAdapterOpen(false)}
        onSave={(adapter) =>
          run(async () => {
            await api(`works/${encoded}/workflows/adapter`, {
              method: 'POST',
              body: JSON.stringify({
                workflowName: runWorkflow,
                version,
                adapter,
              }),
            })
            setAdapterOpen(false)
            notify('已保存 Adapter')
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
            notify(`已把 ${selectedVersion} 检出到 ComfyUI`)
          })
        }
      />
    </>
  )
  return (
    <>
      <section className="column">
        <div className="column-head">
          <h2>{name}</h2>
        </div>
        {detailSection}
      </section>
      <section className="column">{runSection}</section>
      {dialogs}
    </>
  )
}

function versionOf(work: Work | null, workflowName: string, current: string): string {
  const versions =
    work?.workflows.find((item) => item.name === workflowName)?.versions ?? []
  if (versions.some((item) => item.version === current)) return current
  return versions.find((item) => item.main)?.version ?? versions.at(-1)?.version ?? ''
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
  title,
  borrowedFrom,
  adapter,
  suggested,
  fields,
  busy,
  onClose,
  onSave,
}: {
  open: boolean
  title: string
  borrowedFrom: string | null
  adapter: Adapter | null
  suggested: Adapter | null
  fields: FieldDraft[]
  busy: boolean
  onClose: () => void
  onSave: (adapter: Adapter) => Promise<void>
}) {
  const source = adapter ?? suggested
  const [inputs, setInputs] = useState<InputDraft[]>([])
  const [outputs, setOutputs] = useState<OutputDraft[]>([])

  useEffect(() => {
    if (!open) return
    setInputs(inputDrafts(source, fields))
    setOutputs(outputDrafts(source))
  }, [open, source, fields])

  return (
    <Dialog open={open} title={`${title} 的 Adapter`} onClose={onClose}>
      <p>
        {borrowedFrom
          ? `表单里是 ${borrowedFrom} 的 Adapter。保存后记在这一版上，不产生新版本。`
          : '映射保存在这个 Work 和这一版上，不产生新版本。'}
      </p>
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
  onCheckout: (version: string) => Promise<void>
}) {
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [version, setVersion] = useState('')
  const [graph, setGraph] = useState<GraphView | null>(null)

  useEffect(() => {
    if (!workflowName) return
    let stop = false
    api<{ revisions: Revision[] }>(`workflows/${encodeURIComponent(workflowName)}/revisions`)
      .then((body) => {
        if (stop) return
        setRevisions(body.revisions)
        const main = body.revisions.find((item) => item.main)
        setVersion(main?.version ?? body.revisions.at(-1)?.version ?? '')
      })
      .catch((err: unknown) => {
        if (!stop) fail(messageOf(err))
      })
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
      .catch((err: unknown) => {
        if (!stop) fail(messageOf(err))
      })
    return () => {
      stop = true
    }
  }, [workflowName, version])

  return (
    <Dialog open={workflowName !== ''} title={workflowName} onClose={onClose}>
      <h3>版本图</h3>
      <p className="muted">点一个版本查看节点。</p>
      <VersionGraph revisions={revisions} selected={version} onSelect={setVersion} />
      <h3>节点图</h3>
      <p className="muted">
        {version}
        {revisions.find((item) => item.version === version)?.message
          ? ` · ${revisions.find((item) => item.version === version)?.message}`
          : ''}
      </p>
      <Graph nodes={graph?.nodes ?? []} links={graph?.links ?? []} />
      <div className="row">
        <button
          type="button"
          disabled={busy || version === ''}
          onClick={() => void onCheckout(version)}
        >
          检出这一版到 ComfyUI
        </button>
      </div>
    </Dialog>
  )
}

function VersionChoices({
  versions,
  value,
  enabled,
  onChange,
}: {
  versions: WorkVersion[]
  value: string
  enabled: boolean
  onChange: (version: string) => void
}) {
  if (!enabled) {
    return (
      <div className="version-field">
        版本
        <p className="muted">先选择 workflow。</p>
      </div>
    )
  }
  const items = [...versions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  return (
    <div className="version-field">
      版本
      {items.length === 0 ? (
        <p className="muted">还没有版本。</p>
      ) : (
        <div className="version-list" role="listbox" aria-label="版本">
          {items.map((item) => (
            <button
              key={item.version}
              type="button"
              role="option"
              aria-selected={item.version === value}
              className={item.version === value ? 'picked' : undefined}
              onClick={() => onChange(item.version)}
            >
              <span className="version-list-top">
                <span>
                  {item.version}
                  {item.main ? ' (main)' : ''}
                </span>
                <span className="version-list-time">{formatVersionTime(item.createdAt)}</span>
              </span>
              <span className="version-list-note">{item.message?.trim() || '无说明'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function formatVersionTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function VersionGraph({
  revisions,
  selected,
  onSelect,
}: {
  revisions: Revision[]
  selected: string
  onSelect: (version: string) => void
}) {
  if (revisions.length === 0) return <p>还没有版本。</p>
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  function depthOf(version: string): number {
    const cached = depth.get(version)
    if (cached !== undefined) return cached
    if (visiting.has(version)) return 0
    visiting.add(version)
    const parents = revisions.find((item) => item.version === version)?.parents ?? []
    const value =
      parents.length === 0 ? 0 : Math.max(...parents.map((parent) => depthOf(parent))) + 1
    depth.set(version, value)
    return value
  }
  for (const revision of revisions) depthOf(revision.version)
  const columns = new Map<number, Revision[]>()
  for (const revision of revisions) {
    const column = depth.get(revision.version) ?? 0
    const list = columns.get(column) ?? []
    list.push(revision)
    columns.set(column, list)
  }
  const colWidth = 168
  const rowHeight = 72
  const maxRows = Math.max(...[...columns.values()].map((column) => column.length))
  const maxColumn = Math.max(...depth.values())
  const width = (maxColumn + 1) * colWidth + 16
  const height = maxRows * rowHeight + 16
  const placed = revisions.map((revision) => {
    const column = depth.get(revision.version) ?? 0
    const row = (columns.get(column) ?? []).indexOf(revision)
    return { ...revision, left: 8 + column * colWidth, top: 8 + row * rowHeight }
  })
  const byVersion = new Map(placed.map((node) => [node.version, node]))
  return (
    <div className="graph" style={{ width, height }}>
      <svg width={width} height={height}>
        {placed.flatMap((node) =>
          (node.parents ?? []).map((parent) => {
            const from = byVersion.get(parent)
            if (!from) return null
            return (
              <line
                key={`${parent}-${node.version}`}
                x1={from.left + 140}
                y1={from.top + 26}
                x2={node.left}
                y2={node.top + 26}
                stroke="#8a8175"
              />
            )
          }),
        )}
      </svg>
      {placed.map((node) => (
        <button
          key={node.id}
          type="button"
          className={`graph-node${node.version === selected ? ' picked' : ''}`}
          style={{ left: node.left, top: node.top }}
          onClick={() => onSelect(node.version)}
        >
          <strong>{node.version}</strong>
          <span>
            {[node.main ? 'main' : '', node.head ? '当前头' : ''].filter(Boolean).join(' · ') ||
              '版本'}
          </span>
        </button>
      ))}
    </div>
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

