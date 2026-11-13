'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { api, fileHref } from '@/lib/api'
import { terminal, type Task } from '@/lib/types'

function outputPaths(value: string | null | undefined): string[] {
  if (!value) return []
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value) as unknown
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return parsed
      }
    } catch {
      return [value]
    }
  }
  return [value]
}

export function TaskDetail({ id }: { id: string }) {
  const [task, setTask] = useState<Task | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let stop = false
    async function poll() {
      try {
        const next = await api<Task>(`tasks/${id}`)
        if (stop) return
        setTask(next)
        setError('')
        if (!terminal.has(next.status)) {
          window.setTimeout(() => void poll(), 1000)
        }
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void poll()
    return () => {
      stop = true
    }
  }, [id])

  async function cancel() {
    setBusy(true)
    setError('')
    try {
      setTask(await api<Task>(`tasks/${id}/cancel`, { method: 'POST' }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const paths = [
    ...outputPaths(task?.outputPath),
    ...(task?.process?.map((item) => item.path) ?? []),
  ]

  return (
    <>
      {error ? <div className="error">{error}</div> : null}
      <section className="panel">
        <h2>{task?.task ?? '任务'}</h2>
        {task ? (
          <>
            <p>
              <span className={`status ${task.status}`}>{task.status}</span>{' '}
              {task.executor}
              {task.workName ? (
                <>
                  {' '}
                  ·{' '}
                  <Link href={`/works/${encodeURIComponent(task.workName)}`}>
                    {task.workName}
                  </Link>
                </>
              ) : null}
              {task.workflowName ? (
                <>
                  {' '}
                  ·{' '}
                  <Link href={`/workflows/${encodeURIComponent(task.workflowName)}`}>
                    {task.workflowName}
                  </Link>
                  {task.version ? ` v${task.version}` : ''}
                </>
              ) : null}
              {task.comfyPath ? <span className="mono"> · {task.comfyPath}</span> : null}
            </p>
            {task.error ? <div className="error">{task.error}</div> : null}
            {task.outputText ? <div className="output">{task.outputText}</div> : null}
            {paths.length > 0 ? (
              <ul>
                {paths.map((path) => (
                  <li key={path}>
                    <a href={fileHref(`tasks/${id}/files/${path}`)}>{path}</a>
                  </li>
                ))}
              </ul>
            ) : null}
            {task.status === 'pending' || task.status === 'running' ? (
              <button disabled={busy} onClick={() => void cancel()}>
                取消
              </button>
            ) : null}
            <p className="mono">
              {task.id}
              {task.promptId ? ` · ${task.promptId}` : ''}
            </p>
          </>
        ) : (
          <p>正在读取…</p>
        )}
      </section>
    </>
  )
}
