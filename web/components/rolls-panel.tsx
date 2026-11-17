'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api, fileHref } from '@/lib/api'
import { fail, messageOf } from '@/lib/notify'

const ROLLS_PAGE_SIZE = 20

interface PoseEntry {
  id: string
  poseName: string
  variants?: Record<string, { depth?: string }>
}

interface RollRecord {
  id: string
  poseName: string | null
  poseId: string | null
  fields: Record<string, unknown>
  prompt: string
  negative: string | null
  createdAt: string
}

interface GenerationRecord {
  id: string
  taskId: string
  status: string
  outputs: string[]
  seed: number | null
  error: string | null
  createdAt: string
}

const GEN_STATUS_LABEL: Record<string, string> = {
  pending: '等待',
  running: '生成中',
  completed: '完成',
  failed: '失败',
  cancelled: '取消',
  timeout: '超时',
}

function depthUrl(entry: PoseEntry): string | null {
  for (const variant of Object.values(entry.variants ?? {})) {
    const depth = variant?.depth
    if (depth) {
      return `/api/runner/data/pose-file/${depth
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`
    }
  }
  return null
}

export function RollsPanel() {
  const [poses, setPoses] = useState<PoseEntry[]>([])
  const [rows, setRows] = useState<RollRecord[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [detail, setDetail] = useState<RollRecord | null>(null)
  const poseMap = useMemo(() => new Map(poses.map((pose) => [pose.id, pose])), [poses])

  useEffect(() => {
    let cancelled = false
    void api<{ poses: PoseEntry[] }>('data/poses?enabled=true')
      .then((body) => {
        if (!cancelled) setPoses(body.poses)
      })
      .catch(() => {
        // 缩略图缺了也能看记录
      })
    return () => {
      cancelled = true
    }
  }, [])

  const load = useCallback((nextPage: number) => {
    void (async () => {
      try {
        const body = await api<{ total: number; rolls: RollRecord[] }>(
          `dice/rolls?limit=${ROLLS_PAGE_SIZE}&offset=${nextPage * ROLLS_PAGE_SIZE}`,
        )
        setRows(body.rolls)
        setTotal(body.total)
        setLoaded(true)
        if (body.rolls.length === 0 && nextPage > 0) setPage(nextPage - 1)
      } catch (err) {
        fail(messageOf(err))
      }
    })()
  }, [])

  useEffect(() => {
    load(page)
  }, [load, page])

  const pages = Math.max(1, Math.ceil(total / ROLLS_PAGE_SIZE))

  return (
    <section className="panel">
      <div className="column-head">
        <h2>灵感记录</h2>
        <span className="muted">{total} 条</span>
      </div>
      {!loaded ? (
        <p className="muted">加载中…</p>
      ) : rows.length === 0 ? (
        <p className="muted">还没有记录。在 Dice 页提交一次就会出现在这里。</p>
      ) : (
        <>
          <div className="dice-roll-list">
            {rows.map((record) => {
              const pose = record.poseId ? (poseMap.get(record.poseId) ?? null) : null
              const url = pose ? depthUrl(pose) : null
              return (
                <button
                  key={record.id}
                  type="button"
                  className="dice-roll-row"
                  onClick={() => setDetail(record)}
                >
                  {url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="dice-roll-thumb" src={url} alt="" loading="lazy" />
                  ) : (
                    <span className="dice-roll-thumb dice-roll-thumb-empty" />
                  )}
                  <span className="dice-roll-row-main">
                    <span className="dice-roll-row-head">
                      {record.poseName ? (
                        <span className="dice-tier-label tier-common">{record.poseName}</span>
                      ) : (
                        <span className="muted">无 pose</span>
                      )}
                      <span className="muted dice-roll-time">
                        {record.createdAt.slice(5, 16).replace('T', ' ')}
                      </span>
                    </span>
                    <span className="mono dice-roll-prompt">
                      {record.prompt !== '' ? record.prompt : '（空）'}
                    </span>
                  </span>
                  <span className="dice-card-arrow" aria-hidden={true}>
                    ›
                  </span>
                </button>
              )
            })}
          </div>
          {pages > 1 ? (
            <div className="dice-pager">
              <button type="button" className="quiet" onClick={() => setPage(0)} disabled={page === 0}>
                «
              </button>
              <button
                type="button"
                className="quiet"
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                disabled={page === 0}
              >
                ‹
              </button>
              <span className="muted">
                第 {page + 1} / {pages} 页
              </span>
              <button
                type="button"
                className="quiet"
                onClick={() => setPage((current) => Math.min(pages - 1, current + 1))}
                disabled={page >= pages - 1}
              >
                ›
              </button>
              <button
                type="button"
                className="quiet"
                onClick={() => setPage(pages - 1)}
                disabled={page >= pages - 1}
              >
                »
              </button>
            </div>
          ) : null}
        </>
      )}
      {detail ? (
        <RollDetail
          record={detail}
          thumb={
            detail.poseId && poseMap.has(detail.poseId)
              ? depthUrl(poseMap.get(detail.poseId) as PoseEntry)
              : null
          }
          onClose={() => setDetail(null)}
        />
      ) : null}
    </section>
  )
}

function RollDetail({
  record,
  thumb,
  onClose,
}: {
  record: RollRecord
  thumb: string | null
  onClose: () => void
}) {
  const [gens, setGens] = useState<GenerationRecord[] | null>(null)
  const [busy, setBusy] = useState(false)
  const activeRef = useRef(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const refreshGens = useCallback(async () => {
    try {
      const body = await api<{ generations: GenerationRecord[] }>(
        `dice/rolls/${record.id}/generations`,
      )
      setGens(body.generations)
      activeRef.current = body.generations.some(
        (item) => item.status === 'pending' || item.status === 'running',
      )
    } catch {
      // 下一轮再拉
    }
  }, [record.id])

  useEffect(() => {
    void refreshGens()
    const timer = setInterval(() => {
      if (activeRef.current) void refreshGens()
    }, 2500)
    return () => clearInterval(timer)
  }, [refreshGens])

  const generate = useCallback(async () => {
    setBusy(true)
    try {
      await api(`dice/rolls/${record.id}/generate`, { method: 'POST' })
      activeRef.current = true
      await refreshGens()
    } catch (err) {
      fail(messageOf(err))
    }
    setBusy(false)
  }, [record.id, refreshGens])

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text)
  }

  return (
    <div className="dice-detail" role="dialog" aria-modal="true" aria-label="灵感详情">
      <div className="dice-detail-head">
        <button type="button" className="quiet dice-detail-back" onClick={onClose}>
          ‹ 返回
        </button>
        <strong className="dice-roll-detail-title">
          {record.poseName ?? '无 pose'} · {record.createdAt.slice(5, 19).replace('T', ' ')}
        </strong>
      </div>
      <div className="dice-roll-detail-body">
        <div className="dice-roll-detail-block">
          <div className="dice-roll-detail-label">
            <span className="muted">生成 · baseline_v1 · 每次随机 seed</span>
            <button
              type="button"
              className="dice-hero-roll"
              onClick={() => void generate()}
              disabled={busy || !record.poseId}
            >
              {busy ? '提交中…' : '🎲 生成图片'}
            </button>
          </div>
          {!record.poseId ? <p className="muted">这条记录没有 pose，不能出图。</p> : null}
          {gens === null ? null : gens.length === 0 ? (
            <p className="muted">还没生成过。</p>
          ) : (
            <ul className="dice-gen-list">
              {gens.map((item) => (
                <li key={item.id} className="dice-gen-item">
                  <span className={`dice-gen-status st-${item.status}`}>
                    {GEN_STATUS_LABEL[item.status] ?? item.status}
                  </span>
                  {item.seed !== null ? <span className="muted dice-gen-seed">seed {item.seed}</span> : null}
                  {item.status === 'completed' ? (
                    <span className="dice-gen-thumbs">
                      {item.outputs.map((path) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          key={path}
                          src={fileHref(`tasks/${item.taskId}/files/${path}`)}
                          alt="生成结果"
                          loading="lazy"
                        />
                      ))}
                    </span>
                  ) : item.status === 'failed' ? (
                    <span className="dice-gen-error">{item.error ?? '未知错误'}</span>
                  ) : item.status === 'pending' || item.status === 'running' ? (
                    <span className="muted">排队/生成中…</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="dice-pose-result-img" src={thumb} alt={`pose ${record.poseName ?? ''}`} />
        ) : null}
        <div className="dice-roll-detail-block">
          <div className="dice-roll-detail-label">
            <span className="muted">拼合 prompt</span>
            <button type="button" className="quiet" onClick={() => copy(record.prompt)}>
              复制
            </button>
          </div>
          <p className="mono dice-roll-detail-prompt">{record.prompt !== '' ? record.prompt : '（空）'}</p>
        </div>
        {record.negative ? (
          <div className="dice-roll-detail-block">
            <div className="dice-roll-detail-label">
              <span className="muted">负面</span>
              <button type="button" className="quiet" onClick={() => copy(record.negative ?? '')}>
                复制
              </button>
            </div>
            <p className="mono dice-roll-detail-prompt">{record.negative}</p>
          </div>
        ) : null}
        <div className="dice-roll-detail-block">
          <div className="dice-roll-detail-label">
            <span className="muted">结构化字段</span>
            <button
              type="button"
              className="quiet"
              onClick={() => copy(JSON.stringify(record.fields, null, 2))}
            >
              复制 JSON
            </button>
          </div>
          <pre className="dice-json mono">{JSON.stringify(record.fields, null, 2)}</pre>
        </div>
      </div>
    </div>
  )
}
