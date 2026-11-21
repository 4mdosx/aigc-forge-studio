'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { api, fileHref } from '@/lib/api'
import { fail, messageOf, notify } from '@/lib/notify'
import { terminal, type Task } from '@/lib/types'

interface RollConfig {
  workflowPositive: string
  workflowNegative: string
}

interface PoseEntry {
  id: string
  poseName?: string | string[]
}

// 与 runner 的 quickGenerate.ts 保持一致：带姿态走双 CN，纯文生图走无 CN。
const POSE_WORKFLOW = 'base_ax4z_lora_cn_1'
const PLAIN_WORKFLOW = 'baseline_ax4z_lora_v1'

const GEN_STATUS_LABEL: Record<string, string> = {
  pending: '等待',
  running: '生成中',
  completed: '完成',
  failed: '失败',
  cancelled: '取消',
  timeout: '超时',
}

export function QuickGenerate() {
  const [prompt, setPrompt] = useState('')
  const [poseId, setPoseId] = useState('')
  const [poses, setPoses] = useState<PoseEntry[]>([])
  const [loraName, setLoraName] = useState('')
  const [loras, setLoras] = useState<string[]>([])
  const [config, setConfig] = useState<RollConfig | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [busy, setBusy] = useState(false)
  const tasksRef = useRef<Task[]>([])
  tasksRef.current = tasks

  useEffect(() => {
    let cancelled = false
    void api<{ value: RollConfig }>('config/roll_config')
      .then((body) => {
        if (!cancelled) setConfig(body.value)
      })
      .catch((err: unknown) => fail(messageOf(err)))
    void api<{ poses: PoseEntry[] }>('data/poses?enabled=true')
      .then((body) => {
        if (!cancelled) setPoses(body.poses)
      })
      .catch((err: unknown) => fail(messageOf(err)))
    void api<{ loras: string[] }>('comfy/loras')
      .then((body) => {
        if (!cancelled) setLoras(body.loras)
      })
      .catch((err: unknown) => fail(messageOf(err)))
    return () => {
      cancelled = true
    }
  }, [])

  const refresh = useCallback(async () => {
    const current = tasksRef.current
    const active = current.filter((task) => !terminal.has(task.status))
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

  async function generate() {
    const text = prompt.trim()
    if (text === '') return
    setBusy(true)
    try {
      const task = await api<Task>('quick/generate', {
        method: 'POST',
        body: JSON.stringify({
          prompt: text,
          ...(poseId ? { poseId } : {}),
          ...(loraName ? { loraName } : {}),
        }),
      })
      setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)])
      notify(`已提交生成 ${task.id}`)
    } catch (err) {
      fail(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const positiveTail = config?.workflowPositive.trim() ?? ''
  const negative = config?.workflowNegative.trim() ?? ''
  const workflow = poseId === '' ? PLAIN_WORKFLOW : POSE_WORKFLOW
  const groups = poseGroups(poses)

  return (
    <section className="quick-gen" aria-label="快速出图">
      <div className="column quick-gen-form">
        <div className="column-head">
          <h2>快速出图</h2>
          <button type="button" className="dice-hero-roll" disabled={busy || prompt.trim() === ''} onClick={() => void generate()}>
            {busy ? '提交中…' : '生成图片'}
          </button>
        </div>
        <label>
          正面 prompt
          <textarea
            className="prose"
            rows={3}
            value={prompt}
            placeholder="输入要测的正面词"
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <label>
          pose
          <select value={poseId} onChange={(event) => setPoseId(event.target.value)}>
            <option value="">不选</option>
            {groups.map(([name, entries]) => (
              <optgroup key={name} label={name}>
                {entries.map((pose) => (
                  <option key={pose.id} value={pose.id}>
                    {pose.id}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
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
        <p className="muted quick-gen-note">
          {poseId === '' ? `没选 pose，走 ${workflow}。` : `选了 pose，走 ${workflow}。`}
          {positiveTail !== '' ? ` 正面前面会加上：${positiveTail}` : ' 出图设置里的正面词是空的。'}
          {negative !== '' ? ` 负面：${negative}` : ' 出图设置里的负面词是空的。'}
          {' '}其余参数用这条工作流里现有的值，seed 随机。
        </p>
      </div>
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
                {task.status === 'completed' ? (
                  <span className="dice-gen-thumbs">
                    {outputPaths(task.outputPath).map((path) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={path}
                        src={fileHref(`tasks/${task.id}/files/${path}`)}
                        alt="生成结果"
                        loading="lazy"
                      />
                    ))}
                  </span>
                ) : task.status === 'failed' || task.status === 'timeout' ? (
                  <span className="dice-gen-error">{task.error ?? '未知错误'}</span>
                ) : task.status === 'pending' || task.status === 'running' ? (
                  <span className="muted">排队/生成中…</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function poseNameOf(pose: PoseEntry): string {
  if (Array.isArray(pose.poseName)) return pose.poseName.filter(Boolean).join(', ')
  return pose.poseName?.trim() || '未命名'
}

function poseGroups(poses: PoseEntry[]): Array<[string, PoseEntry[]]> {
  const map = new Map<string, PoseEntry[]>()
  for (const pose of poses) {
    const name = poseNameOf(pose)
    const list = map.get(name) ?? []
    list.push(pose)
    map.set(name, list)
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
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
