'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { api } from '@/lib/api'
import type { Revision, Task, Workflow } from '@/lib/types'

export function WorkflowDetail({ name }: { name: string }) {
  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [revisionId, setRevisionId] = useState('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [error, setError] = useState('')
  const [branch, setBranch] = useState('')
  const [message, setMessage] = useState('')
  const [payload, setPayload] = useState('{\n  "text": ""\n}')
  const [parentTaskId, setParentTaskId] = useState('')
  const [filePath, setFilePath] = useState('jobs/image.png')
  const [busy, setBusy] = useState(false)

  const encoded = encodeURIComponent(name)

  async function load() {
    const listed = await api<{ workflows: Workflow[] }>('workflows')
    const current = listed.workflows.find((item) => item.name === name) ?? null
    setWorkflow(current)
    const history = await api<{ revisions: Revision[] }>(
      `workflows/${encoded}/revisions`,
    )
    setRevisions(history.revisions)
    const selected =
      revisionId || history.revisions[history.revisions.length - 1]?.id || ''
    setRevisionId(selected)
    if (selected) {
      const body = await api<{ tasks: Task[] }>(`revisions/${selected}/tasks`)
      setTasks(body.tasks)
    } else {
      setTasks([])
    }
  }

  useEffect(() => {
    load().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    )
    // The first load uses the route name. Later refreshes keep the selected revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  async function queueTask(event: React.FormEvent) {
    event.preventDefault()
    let parsed: Record<string, unknown>
    try {
      const value = JSON.parse(payload) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('payload 必须是 JSON 对象')
      }
      parsed = value as Record<string, unknown>
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    await run(async () => {
      const task = await api<Task>('tasks', {
        method: 'POST',
        body: JSON.stringify({
          executor: 'comfyui',
          task: 'run',
          workflowName: name,
          payload: parsed,
          ...(parentTaskId ? { parentTaskId } : {}),
        }),
      })
      window.location.href = `/tasks/${task.id}`
    })
  }

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    data.set('path', filePath)
    await run(async () => {
      await api('files', { method: 'POST', body: data })
    })
  }

  return (
    <>
      {error ? <div className="error">{error}</div> : null}
      <section className="panel">
        <h2>{name}</h2>
        <p>
          当前分支 {workflow?.currentBranch ?? '…'} · 图{' '}
          <span className="mono">{workflow?.comfyPath}</span>
        </p>
        <div className="row">
          <label>
            分支
            <input value={branch} onChange={(event) => setBranch(event.target.value)} />
          </label>
          <button
            className="quiet"
            disabled={busy || branch === ''}
            onClick={() =>
              run(() =>
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
              run(async () => {
                await api(`workflows/${encoded}/branches`, {
                  method: 'POST',
                  body: JSON.stringify({ name: branch }),
                })
              })
            }
          >
            新建
          </button>
          <button
            className="quiet"
            disabled={busy}
            onClick={() =>
              run(() =>
                api(`workflows/${encoded}/checkout`, { method: 'POST' }).then(
                  () => undefined,
                ),
              )
            }
          >
            检出到 ComfyUI
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void run(() =>
              api(`workflows/${encoded}/commit`, {
                method: 'POST',
                body: JSON.stringify(message ? { message } : {}),
              }).then(() => undefined),
            )
          }}
        >
          <div className="row">
            <label>
              提交说明
              <input value={message} onChange={(event) => setMessage(event.target.value)} />
            </label>
            <button disabled={busy}>提交当前图</button>
          </div>
        </form>
      </section>
      <section className="panel">
        <h2>版本</h2>
        <table>
          <thead>
            <tr>
              <th>版本</th>
              <th>说明</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            {revisions.map((revision) => (
              <tr key={revision.id}>
                <td>
                  <button
                    className="quiet"
                    onClick={() => {
                      setRevisionId(revision.id)
                      api<{ tasks: Task[] }>(`revisions/${revision.id}/tasks`)
                        .then((body) => setTasks(body.tasks))
                        .catch((err: unknown) =>
                          setError(err instanceof Error ? err.message : String(err)),
                        )
                    }}
                  >
                    v{revision.version}
                    {revision.id === revisionId ? ' · 当前' : ''}
                  </button>
                </td>
                <td>{revision.message || '—'}</td>
                <td className="mono">{revision.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2>这个版本的任务</h2>
        <table>
          <thead>
            <tr>
              <th>任务</th>
              <th>状态</th>
              <th>执行器</th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 ? (
              <tr>
                <td colSpan={3}>没有任务。</td>
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
                  <td>{task.executor}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
      <section className="panel">
        <h2>出图任务</h2>
        <form onSubmit={queueTask}>
          <div className="grid">
            <label>
              参数 JSON
              <textarea value={payload} onChange={(event) => setPayload(event.target.value)} />
            </label>
            <label>
              上游任务
              <input
                value={parentTaskId}
                placeholder="LLM 任务 id，可空"
                onChange={(event) => setParentTaskId(event.target.value)}
              />
            </label>
          </div>
          <div className="row">
            <button disabled={busy}>加入队列</button>
          </div>
        </form>
      </section>
      <section className="panel">
        <h2>上传到 ComfyUI input</h2>
        <form onSubmit={upload}>
          <div className="grid">
            <label>
              文件
              <input name="file" type="file" required />
            </label>
            <label>
              相对路径
              <input value={filePath} onChange={(event) => setFilePath(event.target.value)} />
            </label>
          </div>
          <div className="row">
            <button disabled={busy}>上传</button>
          </div>
        </form>
      </section>
    </>
  )
}
