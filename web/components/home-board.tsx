'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { api } from '@/lib/api'
import type { Task, Workflow } from '@/lib/types'

interface ComfyWorkflow {
  path: string
  name: string
  status: 'new' | 'updated' | 'unchanged'
}

export function HomeBoard() {
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [remote, setRemote] = useState<ComfyWorkflow[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    const [library, catalog] = await Promise.all([
      api<{ workflows: Workflow[] }>('workflows'),
      api<{ workflows: ComfyWorkflow[] }>('comfy/workflows'),
    ])
    setWorkflows(library.workflows)
    setRemote(catalog.workflows)
    setSelected((current) =>
      current.filter((path) =>
        catalog.workflows.some(
          (item) => item.path === path && item.status !== 'unchanged',
        ),
      ),
    )
  }

  useEffect(() => {
    load().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    )
  }, [])

  function toggle(path: string) {
    setSelected((current) =>
      current.includes(path)
        ? current.filter((item) => item !== path)
        : [...current, path],
    )
  }

  function selectedPaths(action: 'import' | 'update'): string[] {
    return selected.filter((path) => {
      const item = remote.find((workflow) => workflow.path === path)
      return action === 'import' ? item?.status === 'new' : item?.status === 'updated'
    })
  }

  async function runSelected(action: 'import' | 'update') {
    const paths = selectedPaths(action)
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await api<{
        created: Array<{ name: string }>
        updated: Array<{ name: string; version: number }>
        unchanged: Array<{ name: string }>
        failed: Array<{ path: string; error: string }>
      }>('comfy/workflows', {
        method: 'POST',
        body: JSON.stringify({ action, paths }),
      })
      const lines = [
        ...result.created.map((item) => `${item.name} 已入库`),
        ...result.updated.map((item) => `${item.name} 已创建版本 v${item.version}`),
        ...result.unchanged.map((item) => `${item.name} 已入库`),
      ]
      setNotice(lines.join('\n'))
      if (result.failed.length > 0) {
        setError(result.failed.map((item) => `${item.path}: ${item.error}`).join('\n'))
      }
      setSelected([])
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function createLlm(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const task = await api<Task>('tasks', {
        method: 'POST',
        body: JSON.stringify({
          executor: 'llm',
          task: 'prompt',
          payload: { prompt },
        }),
      })
      window.location.href = `/tasks/${task.id}`
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <>
      {notice ? <div className="note">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}
      <section className="panel">
        <h2>工作流</h2>
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>分支</th>
              <th>ComfyUI 路径</th>
            </tr>
          </thead>
          <tbody>
            {workflows.length === 0 ? (
              <tr>
                <td colSpan={3}>还没有工作流。</td>
              </tr>
            ) : (
              workflows.map((workflow) => (
                <tr key={workflow.id}>
                  <td>
                    <Link href={`/workflows/${encodeURIComponent(workflow.name)}`}>
                      {workflow.name}
                    </Link>
                  </td>
                  <td>{workflow.currentBranch}</td>
                  <td className="mono">{workflow.comfyPath}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
      <section className="panel">
        <h2>从 ComfyUI 建立</h2>
        <table>
          <thead>
            <tr>
              <th>选择</th>
              <th>文件</th>
              <th>入库名称</th>
            </tr>
          </thead>
          <tbody>
            {remote.length === 0 ? (
              <tr>
                <td colSpan={3}>ComfyUI 没有可入库的工作流。</td>
              </tr>
            ) : (
              remote.map((item) => (
                <tr key={item.path}>
                  <td>
                    {item.status === 'unchanged' ? (
                      '已入库'
                    ) : (
                      <input
                        type="checkbox"
                        checked={selected.includes(item.path)}
                        onChange={() => toggle(item.path)}
                        aria-label={item.path}
                      />
                    )}
                    {item.status === 'updated' ? ' 有更新' : ''}
                  </td>
                  <td className="mono">{item.path}</td>
                  <td>{item.name}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <div className="row">
          <button
            disabled={busy || selectedPaths('import').length === 0}
            onClick={() => void runSelected('import')}
          >
            入库
          </button>
          <button
            className="quiet"
            disabled={busy || selectedPaths('update').length === 0}
            onClick={() => void runSelected('update')}
          >
            更新
          </button>
        </div>
      </section>
      <section className="panel">
        <h2>LLM 任务</h2>
        <form onSubmit={createLlm}>
          <label>
            提示词
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} required />
          </label>
          <div className="row">
            <button disabled={busy || prompt.trim() === ''}>提交</button>
          </div>
        </form>
      </section>
    </>
  )
}
