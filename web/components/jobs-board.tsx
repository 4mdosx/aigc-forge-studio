'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { api, fileHref } from '@/lib/api'
import { fail, messageOf, notify } from '@/lib/notify'

type JobStatus = 'pending' | 'running' | 'failed' | 'done'
type CaptureStep = 'prepare' | 'tag' | 'embed'

interface CaptureJob {
  id: string
  assetId: string
  status: JobStatus
  step: CaptureStep
  attempts: number
  maxAttempts: number
  nextRunAt: number
  error: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  assetStatus: string | null
  imgUrl: string
  originalUrl: string | null
}

interface JobList {
  counts: Record<JobStatus, number>
  items: CaptureJob[]
}

const STATUS_LABEL: Record<JobStatus, string> = {
  pending: '等待',
  running: '进行中',
  failed: '失败',
  done: '完成',
}

const STEP_LABEL: Record<CaptureStep, string> = {
  prepare: '预处理',
  tag: '打标',
  embed: '向量',
}

export function JobsBoard() {
  const [body, setBody] = useState<JobList | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)
  const reported = useRef('')

  const load = useCallback(async () => {
    try {
      setBody(await api<JobList>('capture/jobs'))
      reported.current = ''
    } catch (err) {
      const message = messageOf(err)
      if (reported.current === message) return
      reported.current = message
      fail(message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const timer = setInterval(() => void load(), 2000)
    return () => clearInterval(timer)
  }, [load])

  async function retry(id: string) {
    setRetrying(id)
    try {
      await api(`capture/jobs/${id}/retry`, { method: 'POST' })
      notify('已重新排队')
      await load()
    } catch (err) {
      fail(messageOf(err))
    } finally {
      setRetrying(null)
    }
  }

  const counts = body?.counts
  return (
    <section className="panel">
      <h2>采集队列</h2>
      <p className="muted">
        入库之后在这里预处理、打标、算向量。失败会自动退避重试，超过次数后停在失败，可以手动再排队。
      </p>
      <div className="row jobs-counts">
        <span className="status pending">等待 {counts?.pending ?? 0}</span>
        <span className="status running">进行中 {counts?.running ?? 0}</span>
        <span className="status failed">失败 {counts?.failed ?? 0}</span>
        <span className="status done">完成 {counts?.done ?? 0}</span>
      </div>
      {counts && counts.done > 20 ? (
        <p className="muted">完成只列出最近 20 条，上面的数字是全部。</p>
      ) : null}
      {!body ? (
        <p className="muted">读取队列…</p>
      ) : body.items.length === 0 ? (
        <p className="muted">还没有采集任务。</p>
      ) : (
        <div className="jobs-table-wrap">
          <table className="jobs">
            <thead>
              <tr>
                <th>资产</th>
                <th>步骤</th>
                <th>状态</th>
                <th>次数</th>
                <th>下次</th>
                <th>错误</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {body.items.map((job) => (
                <tr key={job.id}>
                  <td>
                    <span className="job-asset">
                      {job.originalUrl ? (
                        <img
                          className="job-thumb"
                          src={fileHref(job.originalUrl.slice(1))}
                          alt=""
                        />
                      ) : null}
                      <span>
                        <span className="mono">{job.assetId}</span>
                        {job.imgUrl ? <span className="muted job-url">{job.imgUrl}</span> : null}
                      </span>
                    </span>
                  </td>
                  <td>{STEP_LABEL[job.step]}</td>
                  <td>
                    <span className={`status ${job.status}`}>{STATUS_LABEL[job.status]}</span>
                  </td>
                  <td className="mono">
                    {job.attempts}/{job.maxAttempts}
                  </td>
                  <td className="muted">{job.status === 'pending' ? when(job.nextRunAt) : '—'}</td>
                  <td className="job-error" title={job.error ?? ''}>
                    {job.error ?? ''}
                  </td>
                  <td>
                    {job.status === 'failed' ? (
                      <button
                        type="button"
                        className="quiet"
                        disabled={retrying === job.id}
                        onClick={() => void retry(job.id)}
                      >
                        重试
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function when(ms: number): string {
  const date = new Date(ms)
  const time = date.toLocaleTimeString('zh-CN', { hour12: false })
  if (date.toDateString() === new Date().toDateString()) return time
  return `${date.toLocaleDateString('zh-CN')} ${time}`
}
