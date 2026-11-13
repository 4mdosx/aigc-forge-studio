'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { api } from '@/lib/api'
import type { Task, Work, Workflow } from '@/lib/types'

interface ComfyWorkflow {
  path: string
  name: string
  status: 'new' | 'updated' | 'unchanged'
}

export function HomeBoard() {
  const [works, setWorks] = useState<Work[]>([])
  const [workName, setWorkName] = useState('')
  const [semantic, setSemantic] = useState(
    '{\n  "inputs": {\n    "text": { "type": "string" },\n    "seed": { "type": "seed" }\n  }\n}',
  )
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [remote, setRemote] = useState<ComfyWorkflow[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    const [library, catalog, jobs] = await Promise.all([
      api<{ workflows: Workflow[] }>('workflows'),
      api<{ workflows: ComfyWorkflow[] }>('comfy/workflows'),
      api<{ works: Work[] }>('works'),
    ])
    setWorks(jobs.works)
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
        ...result.updated.map((item) => `${item.name} 已覆盖当前版本`),
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
        <h2>Work</h2>
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>字段</th>
              <th>workflow</th>
            </tr>
          </thead>
          <tbody>
            {works.length === 0 ? (
              <tr>
                <td colSpan={3}>还没有 Work。</td>
              </tr>
            ) : (
              works.map((work) => (
                <tr key={work.id}>
                  <td>
                    <Link href={`/works/${encodeURIComponent(work.name)}`}>{work.name}</Link>
                  </td>
                  <td className="mono">{Object.keys(work.semantic.inputs).join(', ')}</td>
                  <td>{work.workflows.map((item) => item.name).join(', ') || '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void (async () => {
              setBusy(true)
              setError('')
              try {
                const parsed = JSON.parse(semantic) as unknown
                await api('works', {
                  method: 'POST',
                  body: JSON.stringify({ name: workName, semantic: parsed }),
                })
                setWorkName('')
                await load()
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              } finally {
                setBusy(false)
              }
            })()
          }}
        >
          <div className="grid">
            <label>
              名称
              <input value={workName} onChange={(event) => setWorkName(event.target.value)} />
            </label>
            <label>
              语义配置
              <textarea value={semantic} onChange={(event) => setSemantic(event.target.value)} />
            </label>
          </div>
          <div className="row">
            <button disabled={busy || workName.trim() === ''}>建立 Work</button>
          </div>
        </form>
      </section>
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
                    {item.status === 'updated' ? ' 可覆盖' : ''}
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
            覆盖
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
