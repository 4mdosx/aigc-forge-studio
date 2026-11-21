'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { api, fileHref } from '@/lib/api'
import { fail, messageOf, notify } from '@/lib/notify'

type JobKind = 'generate' | 'capture.process' | 'download' | 'nobg'
type KindFilter = JobKind | 'all'
type StatusFilter = 'all' | 'pending' | 'running' | 'done' | 'failed'

interface UnifiedJob {
  id: string
  kind: JobKind
  status: string
  label: string
  detail: string
  assetId: string | null
  imgUrl: string | null
  originalUrl: string | null
  outputPath: string | null
  workflowName: string | null
  workName: string | null
  step: string | null
  error: string | null
  result: string | null
  attempts: number
  maxAttempts: number
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  elapsedMs: number | null
}

interface AllJobsPage {
  items: UnifiedJob[]
  total: number
  page: number
  size: number
  pages: number
  kind: KindFilter
  status: StatusFilter
  counts: Record<JobKind, number>
  statusCounts: Record<StatusFilter, number>
}

const KIND_LABEL: Record<KindFilter, string> = {
  all: '全部',
  generate: '生成',
  'capture.process': '预处理',
  download: '下载',
  nobg: '去背',
}

const STATUS_LABEL: Record<StatusFilter, string> = {
  all: '全部',
  pending: '等待',
  running: '进行中',
  done: '完成',
  failed: '失败',
}

const RAW_STATUS_LABEL: Record<string, string> = {
  pending: '等待',
  running: '进行中',
  done: '完成',
  completed: '完成',
  skipped: '跳过',
  failed: '失败',
  timeout: '超时',
  cancelled: '取消',
}

const STEP_LABEL: Record<string, string> = {
  prepare: '预处理',
  tag: '打标',
  embed: '向量',
}

const STATUS_ORDER: StatusFilter[] = ['all', 'running', 'pending', 'done', 'failed']
const KIND_ORDER: KindFilter[] = ['all', 'generate', 'capture.process', 'download', 'nobg']

export function JobsBoard() {
  const [kind, setKind] = useState<KindFilter>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [page, setPage] = useState(1)
  const [body, setBody] = useState<AllJobsPage | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)
  const reported = useRef('')

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        kind,
        status,
        page: String(page),
        size: '20',
      })
      setBody(await api<AllJobsPage>(`jobs?${params.toString()}`))
      reported.current = ''
    } catch (err) {
      const message = messageOf(err)
      if (reported.current === message) return
      reported.current = message
      fail(message)
    }
  }, [kind, status, page])

  useEffect(() => {
    setPage(1)
  }, [kind, status])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const timer = setInterval(() => void load(), 3000)
    return () => clearInterval(timer)
  }, [load])

  async function retry(job: UnifiedJob) {
    const endpoint =
      job.kind === 'capture.process'
        ? `capture/jobs/${job.id}/retry`
        : `capture/tasks/${job.id}/retry`
    setRetrying(job.id)
    try {
      await api(endpoint, { method: 'POST' })
      notify('已重新排队')
      await load()
    } catch (err) {
      fail(messageOf(err))
    } finally {
      setRetrying(null)
    }
  }

  const counts = body?.statusCounts
  return (
    <section className="panel">
      <h2>任务队列</h2>
      <p className="muted">
        生成、采集预处理、下载和去背共用一个队列。失败会自动退避重试，超过次数后停在失败，采集类任务可以手动再排队。
      </p>

      <div className="jobs-filters">
        <div className="chips">
          <span className="jobs-filter-label">类型</span>
          {KIND_ORDER.map((value) => (
            <button
              type="button"
              key={value}
              className={kind === value ? 'active' : ''}
              onClick={() => setKind(value)}
            >
              {KIND_LABEL[value]}
              <span className="chip-count">{kindCount(body, value)}</span>
            </button>
          ))}
        </div>
        <div className="chips">
          <span className="jobs-filter-label">状态</span>
          {STATUS_ORDER.map((value) => (
            <button
              type="button"
              key={value}
              className={status === value ? 'active' : ''}
              onClick={() => setStatus(value)}
            >
              {STATUS_LABEL[value]}
              <span className="chip-count">{counts?.[value] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {!body ? (
        <p className="muted">读取队列…</p>
      ) : body.items.length === 0 ? (
        <p className="muted">没有符合条件的任务。</p>
      ) : (
        <div className="jobs-table-wrap">
          <table className="jobs">
            <thead>
              <tr>
                <th>类型</th>
                <th>任务</th>
                <th>状态</th>
                <th>次数</th>
                <th>执行时间</th>
                <th>错误</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {body.items.map((job) => (
                <tr key={job.id}>
                  <td>
                    <span className={`job-kind kind-${job.kind.replace('.', '-')}`}>
                      {KIND_LABEL[job.kind]}
                    </span>
                  </td>
                  <td>
                    <span className="job-asset">
                      <span className="job-thumb-slot">
                        {thumbHref(job) ? (
                          <img className="job-thumb" src={thumbHref(job)!} alt="" />
                        ) : null}
                      </span>
                      <span className="job-asset-text">
                        <span className="mono">{job.label}</span>
                        {job.detail ? <span className="muted job-url">{job.detail}</span> : null}
                        <span className="muted job-url">{job.id}</span>
                      </span>
                    </span>
                  </td>
                  <td>
                    <span className={`status ${statusClass(job.status)}`}>
                      {statusText(job.status)}
                    </span>
                  </td>
                  <td className="mono">{job.attempts > 0 ? `${job.attempts}/${job.maxAttempts}` : '—'}</td>
                  <td className="job-times">
                    <span>{job.startedAt ? when(job.startedAt) : '—'}</span>
                    <span className="muted">{elapsedText(job)}</span>
                  </td>
                  <td className="job-error" title={job.error ?? job.result ?? ''}>
                    {job.error ?? ''}
                  </td>
                  <td>
                    {job.status === 'failed' && job.kind !== 'generate' ? (
                      <button
                        type="button"
                        className="quiet"
                        disabled={retrying === job.id}
                        onClick={() => void retry(job)}
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

      {body && body.pages > 1 ? (
        <div className="row jobs-pager">
          <button
            type="button"
            className="quiet"
            disabled={body.page <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            上一页
          </button>
          <span className="muted">
            第 {body.page} / {body.pages} 页 · 共 {body.total} 条
          </span>
          <button
            type="button"
            className="quiet"
            disabled={body.page >= body.pages}
            onClick={() => setPage((value) => Math.min(body.pages, value + 1))}
          >
            下一页
          </button>
        </div>
      ) : null}
    </section>
  )
}

function kindCount(body: AllJobsPage | null, value: KindFilter): number {
  if (!body) return 0
  if (value === 'all') return Object.values(body.counts).reduce((a, b) => a + b, 0)
  return body.counts[value]
}

function statusClass(status: string): string {
  if (status === 'completed' || status === 'done' || status === 'skipped') return 'done'
  if (status === 'failed' || status === 'timeout' || status === 'cancelled') return 'failed'
  return status
}

function statusText(status: string): string {
  return RAW_STATUS_LABEL[status] ?? status
}

function thumbHref(job: UnifiedJob): string | null {
  if (job.originalUrl) return fileHref(job.originalUrl.replace(/^\//, ''))
  if (job.outputPath?.startsWith('output/')) return fileHref(job.outputPath)
  return null
}

function elapsedText(job: UnifiedJob): string {
  if (job.elapsedMs === null) {
    if (job.finishedAt) return `结束 ${when(job.finishedAt)}`
    return '—'
  }
  const ms = job.elapsedMs
  if (ms < 1000) return `用时 ${ms}ms`
  if (ms < 60_000) return `用时 ${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `用时 ${minutes}m${seconds}s`
}

function when(ms: number): string {
  const date = new Date(ms)
  const time = date.toLocaleTimeString('zh-CN', { hour12: false })
  if (date.toDateString() === new Date().toDateString()) return time
  return `${date.toLocaleDateString('zh-CN')} ${time}`
}
