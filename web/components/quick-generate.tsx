'use client'

import { Search, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api, fileHref } from '@/lib/api'
import { PromptStudio } from './prompt-studio'
import { ZoomImage } from './zoom-image'
import { fail, messageOf, notify } from '@/lib/notify'
import { terminal, type Task } from '@/lib/types'

interface PoseVariant {
  aspect?: string
  gen?: number[]
  bone?: string
  depth?: string
}

interface PoseEntry {
  id: string
  poseName?: string | string[]
  name?: string
  tags?: string[]
  source?: string
  guide?: { view?: string[]; shot?: string[]; framing?: string[] }
  nsfw?: boolean
  enabled?: boolean
  variants?: Record<string, PoseVariant>
}

// source 展示名（未登记的 source 原样显示）
const SOURCE_LABEL: Record<string, string> = {
  'openpose-lib': '公开库',
  img2pose: '自生成',
}

const GEN_STATUS_LABEL: Record<string, string> = {
  pending: '等待',
  running: '生成中',
  completed: '完成',
  failed: '失败',
  cancelled: '取消',
  timeout: '超时',
}

// 与 runner generate.ts 一致：选 pose 走双 CN，不选走无 CN。
const WORKFLOW_LABEL = {
  cn: 'base_ax4z_lora_cn_1',
  base: 'baseline_ax4z_lora_v1',
}

// pose 动作类目中文名（与 manifest poseNames 的 8 组对齐）
const GROUP_LABEL: Record<string, string> = {
  standing: '站立',
  sitting: '坐姿',
  kneeling: '跪姿',
  lying: '躺卧',
  squatting: '蹲姿',
  all_fours: '四肢着地',
  split_leg: '劈叉',
  suspended: '悬空',
}

function poseGroup(pose: PoseEntry): string {
  const value = pose.poseName
  if (Array.isArray(value)) return value.filter(Boolean).join(', ')
  return value?.trim() || '未分组'
}

type ThumbMode = 'depth' | 'bone'

// 取一个可用变体做缩略图；优先竖版（肖像生图更常见），否则取第一个。
// mode 决定缩略图用深度图还是骨架图；某个 pose 缺该图时 fallback 到另一张。
function poseThumb(pose: PoseEntry, mode: ThumbMode): { src: string; gen: number[] } | null {
  const variants = Object.values(pose.variants ?? {}).filter((v) => v?.bone || v?.depth)
  if (variants.length === 0) return null
  const pick =
    variants.find((v) => v.gen && v.gen[1] > v.gen[0]) ??
    variants.find((v) => v.gen) ??
    variants[0]
  const src = mode === 'depth' ? (pick.depth ?? pick.bone) : (pick.bone ?? pick.depth)
  if (!src) return null
  return { src, gen: pick.gen ?? [] }
}

function outputPaths(value: string | null | undefined): string[] {
  if (!value) return []
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value) as unknown
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed
    } catch {
      return [value]
    }
  }
  return [value]
}

export function QuickGenerate() {
  const [prompt, setPrompt] = useState('')
  const [repeat, setRepeat] = useState(1)
  const [poseId, setPoseId] = useState('')
  const [group, setGroup] = useState('')
  const [query, setQuery] = useState('')
  const [thumbMode, setThumbMode] = useState<ThumbMode>('depth')
  const [loraName, setLoraName] = useState('')
  const [loras, setLoras] = useState<string[]>([])
  const [sourceFilter, setSourceFilter] = useState('')
  const [sources, setSources] = useState<string[]>([])
  const [poses, setPoses] = useState<PoseEntry[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [busy, setBusy] = useState(false)
  const tasksRef = useRef<Task[]>([])
  tasksRef.current = tasks

  useEffect(() => {
    let cancelled = false
    const sourceQuery = sourceFilter ? `&source=${encodeURIComponent(sourceFilter)}` : ''
    void api<{ poses: PoseEntry[]; sources: string[] }>(`data/poses?enabled=true${sourceQuery}`)
      .then((body) => {
        if (!cancelled) {
          setPoses(body.poses)
          setSources(body.sources ?? [])
        }
      })
      .catch((err: unknown) => fail(messageOf(err)))
    return () => {
      cancelled = true
    }
  }, [sourceFilter])

  useEffect(() => {
    let cancelled = false
    void api<{ loras: string[] }>('comfy/loras')
      .then((body) => {
        if (!cancelled) setLoras(body.loras)
      })
      .catch((err: unknown) => fail(messageOf(err)))
    return () => {
      cancelled = true
    }
  }, [])

  // 轮询已提交任务的状态
  const refresh = useCallback(async () => {
    const active = tasksRef.current.filter((task) => !terminal.has(task.status))
    if (active.length === 0) return
    const next = await Promise.all(
      active.map((task) => api<Task>(`tasks/${task.id}`).catch(() => task)),
    )
    const byId = new Map(next.map((task) => [task.id, task]))
    setTasks((listed) => listed.map((task) => byId.get(task.id) ?? task))
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 2500)
    return () => window.clearInterval(timer)
  }, [refresh])

  // 分组：按 poseName 聚合，带数量
  const groups = useMemo(() => {
    const counts = new Map<string, number>()
    for (const pose of poses) {
      const name = poseGroup(pose)
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [poses])

  // 当前分组下的 pose，再按搜索词过滤 id / name / tags
  const visiblePoses = useMemo(() => {
    const q = query.trim().toLowerCase()
    return poses.filter((pose) => {
      if (poseGroup(pose) !== group) return false
      if (q === '') return true
      const haystack = [pose.id, pose.name, ...(pose.tags ?? [])].join(' ').toLowerCase()
      return haystack.includes(q)
    })
  }, [poses, group, query])

  // 选中 pose 的详情（可能跨组，单独查）
  const selected = useMemo(
    () => poses.find((pose) => pose.id === poseId) ?? null,
    [poses, poseId],
  )

  const chooseGroup = (name: string) => {
    setGroup(name)
    setPoseId('')
    setQuery('')
  }

  const chooseSource = (value: string) => {
    if (value === sourceFilter) return
    setSourceFilter(value)
    setGroup('')
    setPoseId('')
    setQuery('')
  }

  const generate = async () => {
    const text = prompt.trim()
    if (text === '') return
    setBusy(true)
    try {
      const endpoint = poseId ? 'generate/cn' : 'generate/base'
      const task = await api<Task>(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          prompt: text,
          repeat,
          ...(loraName ? { loraName } : {}),
          ...(poseId ? { poseName: poseId } : {}),
        }),
      })
      setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)])
      notify(`已提交 ${task.id}`)
    } catch (err) {
      fail(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const workflow = poseId ? WORKFLOW_LABEL.cn : WORKFLOW_LABEL.base

  return (
    <section className="quick-gen" aria-label="快速出图">
      {/* 左：出图参数 */}
      <div className="column quick-gen-form">
        <div className="column-head">
          <h2>快速出图</h2>
          <button
            type="button"
            className="dice-hero-roll"
            disabled={busy || prompt.trim() === ''}
            onClick={() => void generate()}
          >
            <Sparkles size={14} />
            {busy ? '提交中…' : '生成图片'}
          </button>
        </div>
        <PromptStudio onPrompt={setPrompt} />
        <label>
          生成用 prompt（四组拼装 / 重组采用结果）
          <textarea
            className="prose"
            rows={2}
            value={prompt}
            placeholder="在上方工作台拆四组或写重组结果；也可直接粘贴"
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <div className="quick-gen-row">
          <label>
            重复次数
            <input
              type="number"
              min={1}
              max={8}
              value={repeat}
              onChange={(event) =>
                setRepeat(Math.max(1, Math.min(8, Number(event.target.value) || 1)))
              }
            />
          </label>
          <label>
            LoRA
            <select value={loraName} onChange={(event) => setLoraName(event.target.value)}>
              <option value="">工作流默认</option>
              {loras.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="quick-gen-pose-summary">
          {selected ? (
            <>
              <span className="quick-gen-pose-tag">已选 pose</span>
              <strong>{selected.name ?? selected.id}</strong>
              <span className="muted">· {selected.id}</span>
              <button
                type="button"
                className="quiet icon"
                aria-label="清除 pose"
                title="清除 pose"
                onClick={() => setPoseId('')}
              >
                <X size={13} />
              </button>
            </>
          ) : (
            <span className="muted">未选 pose —— 纯文生图（无 ControlNet）</span>
          )}
        </div>
        <p className="muted quick-gen-note">
          走 <code>{workflow}</code>。
          {poseId ? ' pose 的骨架图与深度图自动上传，尺寸按 pose 变体。' : ' seed 随机。'}
        </p>
      </div>

      {/* 中：pose 分组 + 缩略图选择 */}
      <div className="column quick-gen-poses">
        <div className="column-head">
          <h2>Pose</h2>
          <div className="pose-head-right">
            <span className="muted">{group ? `${visiblePoses.length} / ${poses.length}` : `${poses.length} 个`}</span>
            <div className="pose-thumb-switch" role="group" aria-label="缩略图类型">
              <button
                type="button"
                className={thumbMode === 'depth' ? 'on' : ''}
                aria-pressed={thumbMode === 'depth'}
                onClick={() => setThumbMode('depth')}
              >
                深度
              </button>
              <button
                type="button"
                className={thumbMode === 'bone' ? 'on' : ''}
                aria-pressed={thumbMode === 'bone'}
                onClick={() => setThumbMode('bone')}
              >
                骨架
              </button>
            </div>
          </div>
        </div>
        <div className="pose-sources" role="group" aria-label="pose 来源">
          <button
            type="button"
            className={sourceFilter === '' ? 'pose-source on' : 'pose-source'}
            aria-pressed={sourceFilter === ''}
            onClick={() => chooseSource('')}
          >
            全部来源
          </button>
          {sources.map((value) => (
            <button
              key={value}
              type="button"
              className={sourceFilter === value ? 'pose-source on' : 'pose-source'}
              aria-pressed={sourceFilter === value}
              title={value}
              onClick={() => chooseSource(value)}
            >
              {SOURCE_LABEL[value] ?? value}
            </button>
          ))}
        </div>
        <div className="pose-groups" role="tablist" aria-label="pose 分组">
          {groups.map(([name, count]) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={group === name}
              className={group === name ? 'pose-group on' : 'pose-group'}
              onClick={() => chooseGroup(name)}
            >
              {GROUP_LABEL[name] ?? name}
              <span className="pose-group-count">{count}</span>
            </button>
          ))}
        </div>
        {group === '' ? (
          <div className="pose-empty">
            <p className="muted">选一个动作类目，查看缩略图。</p>
            <p className="muted">不选 pose 也能直接生图（走无 CN 工作流）。</p>
          </div>
        ) : (
          <>
            <label className="pose-search">
              <Search size={14} />
              <input
                type="search"
                value={query}
                placeholder="搜 id / 名称 / tag"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {visiblePoses.length === 0 ? (
              <p className="muted">没有匹配的 pose。</p>
            ) : (
              <ul className="pose-grid">
                {visiblePoses.map((pose) => {
                  const thumb = poseThumb(pose, thumbMode)
                  return (
                    <li key={pose.id}>
                      <button
                        type="button"
                        className={poseId === pose.id ? 'pose-card on' : 'pose-card'}
                        title={[pose.name, ...(pose.tags ?? [])].filter(Boolean).join(' · ')}
                        onClick={() => setPoseId(pose.id)}
                      >
                        <span className="pose-card-thumb">
                          {thumb ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <ZoomImage
                              src={fileHref(`data/pose-file/${thumb.src}`)}
                              alt={pose.name ?? pose.id}
                              caption={pose.name ?? pose.id}
                              zoomOn="double"
                            />
                          ) : (
                            <span className="pose-card-noimg">无图</span>
                          )}
                          {pose.nsfw ? <span className="pose-card-nsfw">R</span> : null}
                        </span>
                        <span className="pose-card-id">{pose.id}</span>
                        {thumb && thumb.gen.length >= 2 ? (
                          <span className="pose-card-size">
                            {thumb.gen[0]}×{thumb.gen[1]}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </div>

      {/* 右：结果 */}
      <div className="column quick-gen-results">
        <div className="column-head">
          <h2>生成结果</h2>
        </div>
        {tasks.length === 0 ? (
          <p className="muted">还没出过图。</p>
        ) : (
          <ul className="dice-gen-list quick-gen-results-list">
            {tasks.map((task) => (
              <li key={task.id} className="dice-gen-item">
                <span className={`dice-gen-status st-${task.status}`}>
                  {GEN_STATUS_LABEL[task.status] ?? task.status}
                </span>
                <span className="muted quick-gen-task-id">{task.id}</span>
                {task.status === 'completed' ? (
                  <span className="dice-gen-thumbs">
                    {outputPaths(task.outputPath).map((path) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <ZoomImage
                        key={path}
                        src={fileHref(`tasks/${task.id}/files/${path}`)}
                        alt="生成结果"
                      />
                    ))}
                  </span>
                ) : task.status === 'failed' || task.status === 'timeout' ? (
                  <span className="dice-gen-error">{task.error ?? '未知错误'}</span>
                ) : (
                  <span className="muted">排队/生成中…</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
