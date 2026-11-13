'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { api } from '@/lib/api'
import type { Task, Work, Workflow } from '@/lib/types'

function payloadTemplate(work: Work | null): string {
  if (!work) return '{}'
  const payload: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(work.semantic.inputs)) {
    if (field.type === 'seed') payload[key] = 'random'
    else if (field.type === 'image') payload[key] = 'jobs/image.png'
    else payload[key] = ''
  }
  return JSON.stringify(payload, null, 2)
}

export function WorkDetail({ name }: { name: string }) {
  const [work, setWork] = useState<Work | null>(null)
  const [library, setLibrary] = useState<Workflow[]>([])
  const [workflowName, setWorkflowName] = useState('')
  const [version, setVersion] = useState('')
  const [payload, setPayload] = useState('{}')
  const [semanticText, setSemanticText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const encoded = encodeURIComponent(name)

  async function load() {
    const [current, listed] = await Promise.all([
      api<Work>(`works/${encoded}`),
      api<{ workflows: Workflow[] }>('workflows'),
    ])
    setWork(current)
    setLibrary(listed.workflows)
    setSemanticText(JSON.stringify(current.semantic, null, 2))
    setPayload(payloadTemplate(current))
    setWorkflowName((selected) => selected || current.workflows[0]?.name || '')
  }

  useEffect(() => {
    load().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    )
  }, [name])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const choices = library.filter(
    (item) => item.workId === null || item.workId === work?.id,
  )

  return (
    <>
      {error ? <div className="error">{error}</div> : null}
      <section className="panel">
        <h2>{name}</h2>
        <p>语义字段决定出图参数。Adapter 把这些字段映射到某张 workflow。</p>
        <label>
          语义配置
          <textarea
            value={semanticText}
            onChange={(event) => setSemanticText(event.target.value)}
          />
        </label>
        <div className="row">
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const semantic = JSON.parse(semanticText) as unknown
                await api(`works/${encoded}/semantic`, {
                  method: 'POST',
                  body: JSON.stringify({ semantic }),
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
              <th>Adapter</th>
            </tr>
          </thead>
          <tbody>
            {(work?.workflows ?? []).length === 0 ? (
              <tr>
                <td colSpan={3}>还没有挂 workflow。</td>
              </tr>
            ) : (
              work?.workflows.map((workflow) => (
                <tr key={workflow.id}>
                  <td>
                    <Link href={`/workflows/${encodeURIComponent(workflow.name)}`}>
                      {workflow.name}
                    </Link>
                  </td>
                  <td className="mono">{workflow.comfyPath}</td>
                  <td>{workflow.hasAdapter ? '已设置' : '未设置'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <div className="row">
          <label>
            挂上
            <select
              value={workflowName}
              onChange={(event) => setWorkflowName(event.target.value)}
            >
              <option value="">选择 workflow</option>
              {choices.map((workflow) => (
                <option key={workflow.id} value={workflow.name}>
                  {workflow.name}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={busy || workflowName === ''}
            onClick={() =>
              void run(() =>
                api(`works/${encoded}/workflows`, {
                  method: 'POST',
                  body: JSON.stringify({ workflowName }),
                }).then(() => undefined),
              )
            }
          >
            关联
          </button>
        </div>
      </section>
      <section className="panel">
        <h2>出图</h2>
        <p className="note">不传版本就用 main。提交后直接用 Runner 里的这一版构造 /prompt，不写回 ComfyUI。</p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            let parsed: unknown
            try {
              parsed = JSON.parse(payload) as unknown
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err))
              return
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              setError('参数必须是 JSON 对象')
              return
            }
            const selectedVersion = version.trim() === '' ? undefined : Number(version)
            if (
              selectedVersion !== undefined &&
              (!Number.isInteger(selectedVersion) || selectedVersion < 1)
            ) {
              setError('版本必须是正整数')
              return
            }
            void run(async () => {
              const task = await api<Task>('tasks', {
                method: 'POST',
                body: JSON.stringify({
                  executor: 'comfyui',
                  task: 'run',
                  workName: name,
                  workflowName,
                  ...(selectedVersion === undefined ? {} : { version: selectedVersion }),
                  payload: parsed,
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
                value={workflowName}
                onChange={(event) => setWorkflowName(event.target.value)}
              >
                <option value="">选择</option>
                {(work?.workflows ?? []).map((workflow) => (
                  <option key={workflow.id} value={workflow.name}>
                    {workflow.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              版本
              <input
                value={version}
                placeholder="空则使用 main"
                onChange={(event) => setVersion(event.target.value)}
              />
            </label>
          </div>
          <label>
            参数 JSON
            <textarea value={payload} onChange={(event) => setPayload(event.target.value)} />
          </label>
          <div className="row">
            <button disabled={busy || workflowName === ''}>加入队列</button>
          </div>
        </form>
      </section>
    </>
  )
}
