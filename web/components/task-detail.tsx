'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { api, fileHref } from '@/lib/api'
import { fail, messageOf } from '@/lib/notify'
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

function imageFile(path: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(path)
}

export function TaskDetail({ id, embedded = false }: { id: string; embedded?: boolean }) {
  const [task, setTask] = useState<Task | null>(null)
  const [busy, setBusy] = useState(false)
  const reported = useRef('')

  useEffect(() => {
    let stop = false
    async function poll() {
      try {
        const next = await api<Task>(`tasks/${id}`)
        if (stop) return
        setTask(next)
        reported.current = ''
        if (!terminal.has(next.status)) {
          window.setTimeout(() => void poll(), 1000)
        }
      } catch (err) {
        if (stop) return
        const message = messageOf(err)
        if (reported.current === message) return
        reported.current = message
        fail(message)
      }
    }
    void poll()
    return () => {
      stop = true
    }
  }, [id])

  async function cancel() {
    setBusy(true)
    try {
      setTask(await api<Task>(`tasks/${id}/cancel`, { method: 'POST' }))
    } catch (err) {
      fail(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const paths = [
    ...new Set([
      ...outputPaths(task?.outputPath),
      ...(task?.process?.map((item) => item.path) ?? []),
    ]),
  ]

  return (
    <section className={embedded ? 'task-embedded' : 'panel'}>
        <h2>{task?.task ?? '任务'}</h2>
        {task ? (
          <>
            <p>
              <span className={`status ${task.status}`}>{task.status}</span>
              {task.workName ? (
                <>
                  {' '}
                  ·{' '}
                  <Link href={`/library?work=${encodeURIComponent(task.workName)}`}>
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
                  {task.version ? ` ${task.version}` : ''}
                </>
              ) : null}
              {task.comfyPath ? <span className="mono"> · {task.comfyPath}</span> : null}
            </p>
            {task.error ? <div className="error">{task.error}</div> : null}
            {paths.length > 0 ? (
              <ul className="shots">
                {paths.map((path) => {
                  const href = fileHref(`tasks/${id}/files/${path}`)
                  return (
                    <li key={path}>
                      <a href={href}>{path}</a>
                      {imageFile(path) ? <img className="task-shot" src={href} alt="" /> : null}
                    </li>
                  )
                })}
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
  )
}
