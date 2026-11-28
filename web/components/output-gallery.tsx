'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { api, fileHref } from '@/lib/api'
import { ZoomImage } from './zoom-image'
import { fail, messageOf, notify } from '@/lib/notify'

type Status = 'pending' | 'approved' | 'rejected'

interface OutputItem {
  id: string
  path: string
  fileName: string
  jobId: string
  workflowName: string
  task: string
  status: Status
  createdAt: number
  reviewedAt: number | null
  localPath: string | null
}

interface GenerationInfo {
  positive: string
  negative: string
  nodes: Array<{ id: string; type: string; title: string; inputs: Record<string, string> }>
  checkpoint: string
  loras: Array<{ name: string; strength: number }>
  controlnets: Array<{ name: string; strength: number }>
  seed: number | null
  steps: number | null
  cfg: number | null
  sampler: string
  scheduler: string
  denoise: number | null
  width: number | null
  height: number | null
}

interface OutputDetailData {
  item: OutputItem
  recipe: { kind: string; input: Record<string, unknown> } | null
  jobInput: Record<string, unknown> | null
  generation: { prompt: Record<string, unknown> | null; info: GenerationInfo }
  imageUrl: string
}

interface OutputListData {
  total: number
  offset: number
  size: number
  counts: Record<Status, number>
  workflows: string[]
  items: OutputItem[]
}

const STATUS_LABEL: Record<Status, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已拒绝',
}

const TABS: Array<{ id: Status | 'all'; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'pending', label: '待审核' },
  { id: 'approved', label: '已通过' },
  { id: 'rejected', label: '已拒绝' },
]

function formatTime(ms: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

export function OutputGallery() {
  const [tab, setTab] = useState<Status | 'all'>('all')
  const [data, setData] = useState<OutputListData | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<OutputDetailData | null>(null)
  const [busy, setBusy] = useState(false)
  const listRef = useRef<OutputListData | null>(null)
  listRef.current = data

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ offset: '0', size: '60' })
      if (tab !== 'all') params.set('status', tab)
      const body = await api<OutputListData>(`output/assets?${params.toString()}`)
      setData(body)
      setSelectedId((current) =>
        body.items.some((item) => item.id === current)
          ? current
          : (body.items[0]?.id ?? null),
      )
    } catch (err) {
      fail(messageOf(err))
    }
  }, [tab])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    let stop = false
    void api<OutputDetailData>(`output/assets/${encodeURIComponent(selectedId)}`)
      .then((body) => {
        if (!stop) setDetail(body)
      })
      .catch((err: unknown) => {
        if (stop) return
        setDetail(null)
        fail(messageOf(err))
      })
    return () => {
      stop = true
    }
  }, [selectedId])

  const act = useCallback(
    async (action: 'approve' | 'reject') => {
      if (!selectedId) return
      setBusy(true)
      try {
        const updated = await api<OutputItem>(
          `output/assets/${encodeURIComponent(selectedId)}/${action}`,
          { method: 'POST', body: '{}' },
        )
        notify(
          action === 'approve'
            ? `已通过，图片存到 ${updated.localPath ?? 'data/output'}`
            : '已标记为拒绝',
        )
        await load()
        setDetail((current) =>
          current && current.item.id === updated.id
            ? { ...current, item: updated }
            : current,
        )
      } catch (err) {
        fail(messageOf(err))
      } finally {
        setBusy(false)
      }
    },
    [selectedId, load],
  )

  const items = data?.items ?? []
  return (
    <div className="output-split">
      <section className="output-gallery">
        <div className="column-head">
          <div className="tabs" role="tablist" aria-label="审核状态">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? 'active' : ''}
                onClick={() => setTab(id)}
              >
                {label}
                {data ? ` ${id === 'all' ? data.total : data.counts[id]}` : ''}
              </button>
            ))}
          </div>
          <button type="button" className="quiet" onClick={() => void load()}>
            刷新
          </button>
        </div>
        <p className="muted output-note">
          新链路（base / cn）生成图 · 共 {data?.total ?? 0} 张 · 通过后复制到本地 data/output
        </p>
        <div className="output-thumbs">
          {items.length === 0 ? (
            <p className="muted">这个状态下还没有图片。</p>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`output-thumb${item.id === selectedId ? ' active' : ''}`}
                onClick={() => setSelectedId(item.id)}
                title={`${item.path}\n${STATUS_LABEL[item.status]}`}
              >
                <ZoomImage
                  src={fileHref(`output/image/${encodeURIComponent(item.id)}`)}
                  alt={item.fileName}
                  caption={item.fileName}
                  zoomOn="double"
                />
                <span className="output-thumb-bar">
                  <span className={`output-badge ${item.status}`}>{STATUS_LABEL[item.status]}</span>
                  <span className="output-thumb-name">{item.fileName}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </section>

      <section className="output-detail">
        {!detail ? (
          <p className="muted">选择一张图查看生成信息。</p>
        ) : (
          <>
            <div className="column-head">
              <h2>{detail.item.fileName}</h2>
              <span className={`output-badge ${detail.item.status}`}>
                {STATUS_LABEL[detail.item.status]}
              </span>
            </div>
            <ZoomImage
              className="output-preview"
              src={fileHref(`output/image/${encodeURIComponent(detail.item.id)}`)}
              alt={detail.item.fileName}
              caption={detail.item.fileName}
              eager
            />
            <div className="row output-actions">
              <button
                type="button"
                disabled={busy || detail.item.status === 'approved'}
                onClick={() => void act('approve')}
              >
                通过并存档
              </button>
              <button
                type="button"
                className="quiet"
                disabled={busy || detail.item.status === 'rejected'}
                onClick={() => void act('reject')}
              >
                拒绝
              </button>
            </div>

            <h3>任务信息</h3>
            <dl className="output-kv">
              <dt>workflow</dt>
              <dd className="mono">{detail.item.workflowName}</dd>
              <dt>task</dt>
              <dd className="mono">{detail.item.task}</dd>
              <dt>生成时间</dt>
              <dd>{formatTime(detail.item.createdAt)}</dd>
              <dt>ComfyUI 路径</dt>
              <dd className="mono">{detail.item.path}</dd>
              <dt>本地副本</dt>
              <dd className="mono">{detail.item.localPath ?? '未存档'}</dd>
            </dl>

            <h3>任务 recipe</h3>
            {detail.recipe ? (
              <>
                <p className="muted mono">kind: {detail.recipe.kind}</p>
                <dl className="output-kv">
                  {Object.entries(detail.recipe.input).map(([key, value]) => (
                    <div key={key} className="output-kv-row">
                      <dt>{key}</dt>
                      <dd className="mono">{formatValue(value)}</dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : (
              <p className="muted">
                这条任务没有结构化 recipe（旧入口生成）。此时以 PNG metadata 为准。
              </p>
            )}
            {!detail.recipe && detail.jobInput ? (
              <details>
                <summary>查看运行时入参（input_json）</summary>
                <pre className="output-json">{JSON.stringify(detail.jobInput, null, 2)}</pre>
              </details>
            ) : null}

            <h3>ComfyUI 生成信息（来自图片 metadata）</h3>
            <dl className="output-kv">
              <dt>底模</dt>
              <dd className="mono">{detail.generation.info.checkpoint || '—'}</dd>
              <dt>LoRA</dt>
              <dd className="mono">
                {detail.generation.info.loras.length === 0
                  ? '—'
                  : detail.generation.info.loras
                      .map((l) => `${l.name} (${l.strength})`)
                      .join('、')}
              </dd>
              <dt>ControlNet</dt>
              <dd className="mono">
                {detail.generation.info.controlnets.length === 0
                  ? '—'
                  : detail.generation.info.controlnets
                      .map((c) => `${c.name} (${c.strength})`)
                      .join('、')}
              </dd>
              <dt>采样</dt>
              <dd className="mono">
                {[
                  detail.generation.info.sampler,
                  detail.generation.info.scheduler,
                  `steps ${detail.generation.info.steps ?? '—'}`,
                  `cfg ${detail.generation.info.cfg ?? '—'}`,
                  `denoise ${detail.generation.info.denoise ?? '—'}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </dd>
              <dt>seed</dt>
              <dd className="mono">{detail.generation.info.seed ?? '—'}</dd>
              <dt>尺寸</dt>
              <dd className="mono">
                {detail.generation.info.width && detail.generation.info.height
                  ? `${detail.generation.info.width}×${detail.generation.info.height}`
                  : '—'}
              </dd>
            </dl>
            <h4>Positive prompt</h4>
            <pre className="output-prompt">{detail.generation.info.positive || '—'}</pre>
            <h4>Negative prompt</h4>
            <pre className="output-prompt">{detail.generation.info.negative || '—'}</pre>
            <details>
              <summary>节点图（{detail.generation.info.nodes.length} 个节点）</summary>
              <pre className="output-json">
                {JSON.stringify(detail.generation.prompt, null, 2)}
              </pre>
            </details>
          </>
        )}
      </section>
    </div>
  )
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}
