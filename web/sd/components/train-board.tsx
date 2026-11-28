'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { Dialog } from '@/components/dialog'
import { api } from '@/lib/api'
import { fail, messageOf, notify } from '@/lib/notify'

// 训练台：显存水位 + 任务列表（暂停/恢复/取消）+ 一键开训。
// 数据源：
//   /system/gpu   训练机 nvidia-smi + ComfyUI /system_stats（4s 轮询）
//   /train/jobs   任务列表（4s 轮询）
//   /train/jobs/:id/log?tail= 只看日志尾巴算步进（6s 轮询，只对运行中的任务）

type Status = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

interface TrainJob {
  id: string
  name: string
  status: Status
  params: Record<string, unknown>
  outputDir: string | null
  exitCode: number | null
  error: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  pausedAt: string | null
  pid: number | null
}

interface RetrieveInfo {
  jobId: string
  name: string | null
  status: 'idle' | 'running' | 'done' | 'error'
  phase: string
  done: number
  total: number
  files: { file: string; size: number; sha256: string }[]
  error: string | null
  localDir: string | null
}

interface GpuCard {
  index: number
  name: string
  memTotalMiB: number
  memUsedMiB: number
  memFreeMiB: number
  utilization: number | null
  temperatureC: number | null
  powerW: number | null
}

interface GpuProcess {
  pid: number
  name: string
  usedMiB: number
}

interface ComfyStats {
  deviceName: string
  ramTotal: number
  ramFree: number
  vramTotal: number
  vramFree: number
  torchVramTotal: number
  torchVramFree: number
}

interface SystemBody {
  checkedAt: string
  gpu: { gpus: GpuCard[]; processes: GpuProcess[] } | null
  gpuError: string | null
  comfy: ComfyStats | null
  comfyError: string | null
}

interface ProfileRow {
  name: string
  desc: string
  expectImages: [number, number] | null
  params: Record<string, unknown>
}

interface CaptionTier {
  key: string
  name: string
  desc: string
}

interface ProfilesBody {
  profiles: ProfileRow[]
  preset: Record<string, unknown>
  defaultBaseModel: string
  captionTiers: CaptionTier[]
}

interface DatasetRow {
  id: string
  name: string
  count: number
}

interface Progress {
  step: number
  total: number
  rate: string
  eta: string
}

const STATUS_LABEL: Record<Status, string> = {
  pending: '排队',
  running: '运行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
}

// tqdm: `steps: 16%|█▋ | 538/3280 [1:10:10<5:57:41, 7.83s/it, avr_loss=0.091]`
// 尾巴上的 avr_loss 可有可无（第一步还没算出来），所以不锚行尾
const STEP_RE = /(\d+)\/(\d+) \[([0-9:]+)<([0-9:]+),\s*([0-9.]+\s*(?:s\/it|it\/s))/

export function TrainBoard() {
  const [system, setSystem] = useState<SystemBody | null>(null)
  const [systemError, setSystemError] = useState('')
  const [jobs, setJobs] = useState<TrainJob[] | null>(null)
  const [profiles, setProfiles] = useState<ProfilesBody | null>(null)
  const [datasets, setDatasets] = useState<DatasetRow[]>([])
  const [tail, setTail] = useState('')
  // 瞬时步速：tqdm 报的是全程平均（被开局慢步污染），这里用相邻两次轮询的步差自己算
  const [instant, setInstant] = useState<number | null>(null)
  const lastSample = useRef<{ step: number; at: number } | null>(null)
  const sampleJobId = useRef('')
  const [freeing, setFreeing] = useState(false)
  const [pendingId, setPendingId] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>('')

  const [dataset, setDataset] = useState('')
  const [trigger, setTrigger] = useState('')
  const [tier, setTier] = useState('')
  const [styleTags, setStyleTags] = useState('')
  const [profile, setProfile] = useState('seed')
  const [jobName, setJobName] = useState('')

  const [logJob, setLogJob] = useState<TrainJob | null>(null)
  const [logText, setLogText] = useState('')
  const logRef = useRef<HTMLPreElement>(null)
  const [retrieves, setRetrieves] = useState<Record<string, RetrieveInfo>>({})
  const [retrievePending, setRetrievePending] = useState('')

  const loadSystem = useCallback(async () => {
    try {
      setSystem(await api<SystemBody>('system/gpu'))
      setSystemError('')
    } catch (err) {
      setSystemError(messageOf(err))
    }
  }, [])

  const sampleSpeed = useCallback((text: string) => {
    const parsed = parseProgress(text)
    if (!parsed) {
      lastSample.current = null
      setInstant(null)
      return
    }
    const now = Date.now()
    const prev = lastSample.current
    if (prev && parsed.step > prev.step) {
      const perStep = (now - prev.at) / 1000 / (parsed.step - prev.step)
      // 暂停/恢复后的第一段会被停顿污染，超过 2 分钟/步的样本直接丢
      if (perStep > 0 && perStep < 120) setInstant(perStep)
    }
    lastSample.current = { step: parsed.step, at: now }
  }, [])

  const loadRetrieves = useCallback(async (list: TrainJob[]) => {
    const completed = list.filter((job) => job.status === 'completed')
    if (completed.length === 0) return
    const entries = await Promise.all(
      completed.map(async (job) => {
        try {
          const info = await api<RetrieveInfo>(`train/jobs/${encodeURIComponent(job.id)}/retrieve`)
          return [job.id, info] as const
        } catch {
          return null
        }
      }),
    )
    setRetrieves((current) => {
      const next = { ...current }
      for (const entry of entries) if (entry) next[entry[0]] = entry[1]
      return next
    })
  }, [])

  const loadJobs = useCallback(async () => {
    try {
      const body = await api<{ jobs: TrainJob[] }>('train/jobs')
      const sorted = [...body.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      setJobs(sorted)
      void loadRetrieves(sorted)
      const active = sorted.find((job) => job.status === 'running')
      if (!active) {
        setTail('')
        return
      }
      if (sampleJobId.current !== active.id) {
        sampleJobId.current = active.id
        lastSample.current = null
        setInstant(null)
      }
      const text = await readText(`train/jobs/${active.id}/log?tail=6000`)
      setTail(text)
      sampleSpeed(text)
    } catch (err) {
      setJobs([])
      fail(`训练任务读取失败：${messageOf(err)}`)
    }
  }, [sampleSpeed, loadRetrieves])

  useEffect(() => {
    void loadSystem()
    void loadJobs()
    void api<ProfilesBody>('train/profiles')
      .then(setProfiles)
      .catch((err: unknown) => fail(messageOf(err)))
    void api<{ datasets: DatasetRow[] }>('datasets')
      .then((body) => {
        setDatasets(body.datasets)
        setDataset((current) => current || body.datasets[0]?.name || '')
      })
      .catch(() => setDatasets([]))
  }, [loadSystem, loadJobs])

  useEffect(() => {
    const timer = setInterval(() => void loadSystem(), 4000)
    return () => clearInterval(timer)
  }, [loadSystem])

  useEffect(() => {
    const timer = setInterval(() => void loadJobs(), 5000)
    return () => clearInterval(timer)
  }, [loadJobs])

  // 回程是大文件传输：只有存在 running 的回程任务时才加密集轮询
  useEffect(() => {
    if (!Object.values(retrieves).some((info) => info.status === 'running')) return
    const timer = setInterval(() => void loadRetrieves(jobs ?? []), 2000)
    return () => clearInterval(timer)
  }, [retrieves, jobs, loadRetrieves])

  const lastRetrieveStatus = useRef<Record<string, string>>({})
  useEffect(() => {
    for (const [id, info] of Object.entries(retrieves)) {
      const prev = lastRetrieveStatus.current[id]
      lastRetrieveStatus.current[id] = info.status
      if (prev === 'running' && info.status === 'done') {
        notify(`产物已回程：${info.localDir ?? 'data/lora'}`)
      } else if (prev === 'running' && info.status === 'error') {
        fail(`回程失败：${info.error ?? '未知错误'}`)
      }
    }
  }, [retrieves])

  // 日志弹窗：打开时拉全量，之后每 3s 刷新并滚到底
  useEffect(() => {
    if (!logJob) return
    let alive = true
    const pull = async () => {
      try {
        const text = await readText(`train/jobs/${logJob.id}/log?tail=200000`)
        if (alive) setLogText(tidyLog(text))
      } catch (err) {
        if (alive) setLogText(`读取日志失败：${messageOf(err)}`)
      }
    }
    void pull()
    const timer = setInterval(() => void pull(), 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [logJob])

  useEffect(() => {
    const node = logRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [logText])

  async function freeComfy() {
    setFreeing(true)
    try {
      const body = await api<{ before: ComfyStats | null; after: ComfyStats }>(
        'system/comfy/free',
        { method: 'POST' },
      )
      const vram = Math.max(0, body.after.vramFree - (body.before?.vramFree ?? 0))
      const ram = Math.max(0, body.after.ramFree - (body.before?.ramFree ?? 0))
      // 实测 VRAM 常常只降到 ComfyUI 的 torch 池，真正被还回来的是内存
      notify(
        body.before
          ? `已卸载模型：显存 +${mib(vram)}MB，内存 +${mib(ram)}MB`
          : '已通知 ComfyUI 卸载模型',
      )
      await loadSystem()
    } catch (err) {
      fail(messageOf(err))
    } finally {
      setFreeing(false)
    }
  }

  async function act(job: TrainJob, action: 'pause' | 'resume' | 'cancel') {
    setPendingId(job.id)
    try {
      if (action === 'cancel') {
        if (!confirm(`取消 ${job.name}？已训练的进度不会保留权重。`)) return
        await api(`train/jobs/${job.id}`, { method: 'DELETE' })
        notify('已取消')
      } else {
        await api(`train/jobs/${job.id}/${action}`, { method: 'POST' })
        notify(action === 'pause' ? '已暂停（GPU 仍占用，进程冻结）' : '已恢复')
      }
      await loadJobs()
    } catch (err) {
      fail(messageOf(err))
    } finally {
      setPendingId('')
    }
  }

  async function retrieveArtifacts(job: TrainJob) {
    setRetrievePending(job.id)
    try {
      const info = await api<RetrieveInfo>(
        `train/jobs/${encodeURIComponent(job.id)}/retrieve`,
        { method: 'POST' },
      )
      setRetrieves((current) => ({ ...current, [job.id]: info }))
      if (info.status === 'done') {
        notify(`产物已回程：${info.localDir ?? 'data/lora'}`)
      } else {
        notify('开始回程产物：拉回 data/lora 并部署到 ComfyUI，权重较大需等几分钟')
      }
    } catch (err) {
      fail(messageOf(err))
    } finally {
      setRetrievePending('')
    }
  }

  async function start(dry: boolean) {
    if (!dataset) {
      fail('先选一个数据集')
      return
    }
    setBusy(true)
    try {
      const body = await api<Record<string, unknown>>('train/start', {
        method: 'POST',
        body: JSON.stringify({
          dataset,
          ...(trigger.trim() ? { trigger: trigger.trim() } : {}),
          ...(tier ? { tier } : {}),
          ...(styleTags.trim() ? { styleTags: styleTags.trim() } : {}),
          profile,
          ...(jobName.trim() ? { name: jobName.trim() } : {}),
          dryRun: dry,
        }),
      })
      const lines = [
        `${dry ? '试算' : '已开训'}：${String(body.dataset ?? dataset)}`,
        `${String(body.images ?? '?')} 图 · ${String(body.steps ?? '?')} 步 · profile ${String(body.profile ?? profile)}`,
        `caption 档位 ${String(body.tier ?? 'raw')}${body.sample ? ` · 样例「${String(body.sample)}」` : ''}`,
        String(body.name ?? ''),
      ]
      if (body.warn) lines.push(`⚠ ${String(body.warn)}`)
      if (body.comfyFree) lines.push(`显存：${String(body.comfyFree)}`)
      setResult(lines.join('\n'))
      if (!dry) {
        notify('训练任务已创建')
        setJobName('')
        await loadJobs()
      }
    } catch (err) {
      setResult('')
      fail(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const running = jobs?.find((job) => job.status === 'running')
  const progress = running ? parseProgress(tail) : null
  const card = system?.gpu?.gpus[0]
  const comfy = system?.comfy
  // trainer 还是旧进程时 /gpu 与暂停/恢复都返 404：按不可用渲染，别让人点了才发现
  const trainerStale = Boolean(system?.gpuError?.includes('HTTP 404'))

  return (
    <div className="train-split">
      <section className="panel">
        <h2>显存</h2>
        {!system ? (
          <p className="muted">{systemError || '读取显存…'}</p>
        ) : (
          <>
            <div className="vram-head">
              <span className="vram-amount">
                {card ? `${gib(card.memUsedMiB * 1024 * 1024)} / ${gib(card.memTotalMiB * 1024 * 1024)} GB` : '—'}
              </span>
              <span className="muted">
                {card ? `空闲 ${gib(card.memFreeMiB * 1024 * 1024)} GB` : '拿不到 nvidia-smi'}
              </span>
            </div>
            <div className="vram-bar">
              <span
                className={`vram-fill ${toneOf(card ? card.memUsedMiB / card.memTotalMiB : 0)}`}
                style={{ width: `${card ? Math.min(100, (card.memUsedMiB / card.memTotalMiB) * 100) : 0}%` }}
              />
            </div>
            <div className="vram-metrics">
              <Metric label="GPU" value={card?.utilization !== null && card ? `${card.utilization}%` : '—'} />
              <Metric label="温度" value={card?.temperatureC != null ? `${card.temperatureC}℃` : '—'} />
              <Metric label="功耗" value={card?.powerW != null ? `${Math.round(card.powerW)}W` : '—'} />
              <Metric
                label="内存"
                value={comfy && comfy.ramTotal ? `${gib(comfy.ramFree)} / ${gib(comfy.ramTotal)} GB` : '—'}
              />
              <Metric
                label="ComfyUI"
                value={comfy ? `${gib(comfy.torchVramTotal)} GB` : '—'}
              />
            </div>
            {system.gpuError ? (
              <p className="muted mono vram-warn">GPU: {system.gpuError}</p>
            ) : null}
            {system.comfyError ? (
              <p className="muted mono vram-warn">ComfyUI: {system.comfyError}</p>
            ) : null}

            {system.gpu?.processes.length ? (
              <table className="vram-procs">
                <thead>
                  <tr>
                    <th>进程</th>
                    <th>显存</th>
                  </tr>
                </thead>
                <tbody>
                  {system.gpu.processes.map((proc) => (
                    <tr key={proc.pid}>
                      <td className="mono">
                        {proc.pid} · {proc.name}
                      </td>
                      <td className="mono">{proc.usedMiB} MB</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}

            <div className="row">
              <button type="button" className="quiet" onClick={() => void loadSystem()}>
                刷新
              </button>
              <button type="button" disabled={freeing} onClick={() => void freeComfy()}>
                {freeing ? '卸载中…' : '清理 ComfyUI 显存'}
              </button>
            </div>
            <p className="muted vram-hint">
              {trainerStale
                ? '暂停/恢复与逐进程显存要等训练机 trainer 重启服务后生效（重启会中断当前任务）。'
                : '训练期间别用 ComfyUI 出图：模型一 staged，步速会掉到 1/6。'}
            </p>
          </>
        )}
      </section>

      <section className="panel">
        <h2>开始训练</h2>
        <div className="train-form">
          <label>
            数据集
            <select value={dataset} onChange={(event) => setDataset(event.target.value)}>
              {datasets.length === 0 ? <option value="">（没有数据集）</option> : null}
              {datasets.map((item) => (
                <option key={item.id} value={item.name}>
                  {item.name}（{item.count}）
                </option>
              ))}
            </select>
          </label>
          <label>
            触发词
            <input
              value={trigger}
              placeholder="oil_style（锁 caption 首 token）"
              onChange={(event) => setTrigger(event.target.value)}
            />
          </label>
          <label>
            Caption 档位
            <select value={tier} onChange={(event) => setTier(event.target.value)}>
              <option value="">原样（触发词 + 全部 tag）</option>
              {(profiles?.captionTiers ?? []).map((item) => (
                <option key={item.key} value={item.key}>
                  {item.key} · {item.name}
                </option>
              ))}
            </select>
          </label>
          {tier && tier !== 'T2' && tier !== 'T3' ? (
            <label>
              恒定风格词（可选，留空则只保留触发词）
              <input
                value={styleTags}
                placeholder="painterly, dark cinematic lighting, black-gold armor"
                onChange={(event) => setStyleTags(event.target.value)}
              />
            </label>
          ) : null}
          <label>
            Profile
            <select value={profile} onChange={(event) => setProfile(event.target.value)}>
              {(profiles?.profiles ?? []).map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            任务名
            <input
              value={jobName}
              placeholder="留空自动生成"
              onChange={(event) => setJobName(event.target.value)}
            />
          </label>
        </div>
        {profiles ? (
          <p className="muted train-profile-desc">
            {tier
              ? (profiles.captionTiers.find((item) => item.key === tier)?.desc ?? '')
              : '原样档：caption = 触发词 + 全部 WD14 tag（仅剥角色名、背景与画质噪声）。'}
            <br />
            {profiles.profiles.find((item) => item.name === profile)?.desc ?? ''}
            <br />
            底模 {profiles.defaultBaseModel.replace(/^.*\//, '').replace(/\.safetensors$/, '')}
          </p>
        ) : null}
        <div className="row">
          <button type="button" disabled={busy} onClick={() => void start(false)}>
            {busy ? '提交中…' : '开始训练'}
          </button>
          <button type="button" className="quiet" disabled={busy} onClick={() => void start(true)}>
            仅试算
          </button>
        </div>
        {result ? <p className="note train-result">{result}</p> : null}
      </section>

      <section className="panel train-jobs">
        <h2>训练任务</h2>
        {!jobs ? (
          <p className="muted">读取任务…</p>
        ) : jobs.length === 0 ? (
          <p className="muted">还没有训练任务。</p>
        ) : (
          <div className="jobs-table-wrap">
            <table className="jobs">
              <thead>
                <tr>
                  <th>任务</th>
                  <th>状态</th>
                  <th>进度</th>
                  <th>时间</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const paused = job.status === 'running' && Boolean(job.pausedAt)
                  return (
                    <tr key={job.id}>
                      <td>
                        <span className="mono">{job.name}</span>
                        <span className="muted job-url">{summaryOf(job.params)}</span>
                        <span className="muted job-url">
                          {job.id}
                          {job.pid ? ` · pid ${job.pid}` : ''}
                        </span>
                      </td>
                      <td>
                        <span className={`status ${paused ? 'paused' : job.status}`}>
                          {paused ? '暂停中' : STATUS_LABEL[job.status]}
                        </span>
                      </td>
                      <td className="train-progress">
                        {job.status === 'running'
                          ? paused
                            ? '已冻结'
                            : progress
                              ? [
                                  `${progress.step}/${progress.total}`,
                                  instant ? `${instant.toFixed(1)} s/it` : progress.rate,
                                  // 瞬时有了就用瞬时推剩余（tqdm 的 ETA 是全程平均，被开局慢步拖成假值）
                                  instant
                                    ? `剩 ${etaText((progress.total - progress.step) * instant)}`
                                    : `ETA ${progress.eta}`,
                                ].join(' · ')
                              : '等日志…'
                          : job.status === 'completed'
                            ? '已出权重'
                            : job.error
                              ? job.error.slice(0, 40)
                              : '—'}
                      </td>
                      <td className="job-times">
                        <span>{job.startedAt ? when(job.startedAt) : when(job.createdAt)}</span>
                        <span className="muted">{durationOf(job)}</span>
                      </td>
                      <td className="train-actions">
                        {job.status === 'running' ? (
                          <button
                            type="button"
                            className="quiet"
                            disabled={pendingId === job.id || trainerStale}
                            title={trainerStale ? '训练机 trainer 未更新，重启服务后可用' : undefined}
                            onClick={() => void act(job, paused ? 'resume' : 'pause')}
                          >
                            {paused ? '恢复' : '暂停'}
                          </button>
                        ) : null}
                        {job.status === 'running' || job.status === 'pending' ? (
                          <button
                            type="button"
                            className="quiet"
                            disabled={pendingId === job.id}
                            onClick={() => void act(job, 'cancel')}
                          >
                            取消
                          </button>
                        ) : null}
                        {job.status === 'completed' ? (() => {
                          const info = retrieves[job.id]
                          const state = info?.status ?? 'idle'
                          const label =
                            state === 'done'
                              ? '已回程'
                              : state === 'running'
                                ? info.total
                                  ? `回程中 ${info.done}/${info.total}`
                                  : '回程中'
                                : state === 'error'
                                  ? '重试回程'
                                  : '回程产物'
                          const title =
                            state === 'done'
                              ? `权重在 ${info?.localDir ?? 'data/lora'}；ComfyUI 已可见`
                              : state === 'error'
                                ? info?.error ?? ''
                                : state === 'running'
                                  ? info?.phase || '传输中'
                                  : '拉回权重到 data/lora，并部署到训练机 models/loras'
                          return (
                            <button
                              type="button"
                              className="quiet"
                              disabled={
                                retrievePending === job.id || state === 'running' || state === 'done'
                              }
                              title={title}
                              onClick={() => void retrieveArtifacts(job)}
                            >
                              {label}
                            </button>
                          )
                        })() : null}
                        <button
                          type="button"
                          className="quiet"
                          onClick={() => {
                            setLogText('')
                            setLogJob(job)
                          }}
                        >
                          日志
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Dialog
        open={logJob !== null}
        title={`日志 · ${logJob?.name ?? ''}`}
        className="train-log-dialog"
        onClose={() => setLogJob(null)}
      >
        <pre ref={logRef} className="output train-log">
          {logText || '读取中…'}
        </pre>
      </Dialog>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="vram-metric">
      <span className="vram-metric-label">{label}</span>
      <span className="vram-metric-value mono">{value}</span>
    </div>
  )
}

async function readText(path: string): Promise<string> {
  const res = await fetch(`/api/runner/${path}`)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`)
  return res.text()
}

// tqdm 每步都写一行 \r 刷新，原始日志里同一段进度会重复上百次。
// 连续的一串进度行只保留最后一条，其余原样。
const PROGRESS_LINE_RE = /\d+\/\d+ \[[0-9:]+<[0-9:]+,/

function tidyLog(text: string): string {
  const lines = text.split(/[\r\n]+/)
  const out: string[] = []
  let pending: string | null = null
  for (const line of lines) {
    if (PROGRESS_LINE_RE.test(line)) {
      pending = line
      continue
    }
    if (pending) {
      out.push(pending)
      pending = null
    }
    out.push(line)
  }
  if (pending) out.push(pending)
  return out.join('\n')
}

function parseProgress(text: string): Progress | null {
  const lines = text.split(/[\r\n]+/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = STEP_RE.exec(lines[i]!)
    if (match) {
      return {
        step: Number(match[1]),
        total: Number(match[2]),
        rate: match[5]!.trim(),
        eta: match[4]!,
      }
    }
  }
  return null
}

function etaText(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.round((total % 3600) / 60)
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  return `${minutes}m`
}

function toneOf(ratio: number): string {
  if (ratio >= 0.92) return 'hot'
  if (ratio >= 0.75) return 'warm'
  return 'cool'
}

function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1)
}

function mib(bytes: number): number {
  return Math.round(bytes / 1024 ** 2)
}

function summaryOf(params: Record<string, unknown>): string {
  const dim = params.networkDim
  const repeats = params.numRepeats
  const epochs = params.maxTrainEpochs
  if (dim === undefined && repeats === undefined) return ''
  return `dim${dim ?? '?'} · ${repeats ?? '?'}rep × ${epochs ?? '?'}ep`
}

function when(iso: string): string {
  const date = new Date(iso)
  const time = date.toLocaleTimeString('zh-CN', { hour12: false })
  if (date.toDateString() === new Date().toDateString()) return time
  return `${date.toLocaleDateString('zh-CN')} ${time}`
}

function durationOf(job: TrainJob): string {
  const start = job.startedAt ? new Date(job.startedAt).getTime() : null
  if (!start) return job.status === 'pending' ? '未开始' : ''
  const end = job.completedAt ? new Date(job.completedAt).getTime() : Date.now()
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}
