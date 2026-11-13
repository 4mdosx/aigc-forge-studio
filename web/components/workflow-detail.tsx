'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { api } from '@/lib/api'
import { fail, messageOf, notify } from '@/lib/notify'
import type { Revision, Task, Workflow } from '@/lib/types'

export function WorkflowDetail({ name }: { name: string }) {
  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [taskRevision, setTaskRevision] = useState('')
  const [branch, setBranch] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const encoded = encodeURIComponent(name)

  async function load() {
    const listed = await api<{ workflows: Workflow[] }>('workflows')
    setWorkflow(listed.workflows.find((item) => item.name === name) ?? null)
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
    load().catch((err: unknown) => fail(messageOf(err)))
    // The first load uses the route name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

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

  const shown = revisions.find((item) => item.id === taskRevision)

  return (
    <>
      <section className="panel">
        <h2>{name}</h2>
        <p>
          当前分支 {workflow?.currentBranch ?? '…'} · 图{' '}
          <span className="mono">{workflow?.comfyPath}</span>
          {workflow && workflow.works.length > 0 ? (
            <>
              {' '}
              ·{' '}
              {workflow.works.map((workName, index) => (
                <span key={workName}>
                  {index > 0 ? '、' : null}
                  <Link href={`/?work=${encodeURIComponent(workName)}`}>{workName}</Link>
                </span>
              ))}
            </>
          ) : (
            ' · 尚未挂到 Work'
          )}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              const created = await api<{ version: string }>(`workflows/${encoded}/commit`, {
                method: 'POST',
                body: JSON.stringify(message.trim() ? { message: message.trim() } : {}),
              })
              setMessage('')
              notify(`已从 ComfyUI 建立 ${created.version}`)
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
          <p className="muted">从 ComfyUI 里这张图的当前内容收一个新版本。已有版本不会被改掉。</p>
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
                    notify(`已把 ${revision.version} 同步到 ComfyUI`)
                  })
                }
                onMessage={(text) =>
                  run(async () => {
                    await api(`workflows/${encoded}/revisions/${revision.version}/message`, {
                      method: 'POST',
                      body: JSON.stringify({ message: text }),
                    })
                    notify(`已保存 ${revision.version} 的说明`)
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
        <p className="muted">{shown ? shown.version : '还没有版本'}</p>
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
    </>
  )
}

function VersionItem({
  revision,
  busy,
  onSync,
  onMessage,
}: {
  revision: Revision
  busy: boolean
  onSync: () => void
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
          {revision.version}
          {revision.main ? ' · main' : ''}
          {revision.head ? ' · 当前头' : ''}
        </strong>
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
      <div className="row">
        <button type="button" className="quiet" disabled={busy} onClick={onSync}>
          同步到 ComfyUI
        </button>
      </div>
    </li>
  )
}
