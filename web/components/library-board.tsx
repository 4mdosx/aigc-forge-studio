'use client'

import Link from 'next/link'
import { useEffect, useState, type FormEvent } from 'react'

import { Dialog } from '@/components/dialog'
import { api } from '@/lib/api'
import { fail, messageOf, notify } from '@/lib/notify'
import type { Workflow } from '@/lib/types'

interface LibraryFile {
  name: string
  path: string
}

interface ComfyWorkflow {
  path: string
  name: string
  status: 'new' | 'updated' | 'unchanged'
}

export function LibraryBoard() {
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [remote, setRemote] = useState<ComfyWorkflow[]>([])
  const [picked, setPicked] = useState('')
  const [open, setOpen] = useState(false)
  const [inputs, setInputs] = useState<LibraryFile[]>([])
  const [outputs, setOutputs] = useState<LibraryFile[]>([])
  const [filePath, setFilePath] = useState('')
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'list' | 'grid'>('list')
  const [tab, setTab] = useState<'input' | 'output' | 'workflow'>('input')

  async function load() {
    const [library, inputFiles, outputFiles] = await Promise.all([
      api<{ workflows: Workflow[] }>('workflows'),
      api<{ files: LibraryFile[] }>('files?type=input'),
      api<{ files: LibraryFile[] }>('files?type=output'),
    ])
    setWorkflows(library.workflows)
    setInputs(inputFiles.files)
    setOutputs(outputFiles.files)
  }

  useEffect(() => {
    load().catch((err: unknown) => fail(messageOf(err)))
  }, [])

  useEffect(() => {
    if (!open) return
    let stop = false
    api<{ workflows: ComfyWorkflow[] }>('comfy/workflows')
      .then((body) => {
        if (stop) return
        setRemote(body.workflows)
        setPicked((current) =>
          body.workflows.some((item) => item.path === current) ? current : '',
        )
      })
      .catch((err: unknown) => {
        if (!stop) fail(messageOf(err))
      })
    return () => {
      stop = true
    }
  }, [open])

  const chosen = remote.find((item) => item.path === picked) ?? null
  const action =
    chosen?.status === 'updated' ? 'update' : chosen?.status === 'new' ? 'import' : null

  async function apply() {
    if (!chosen || !action) return
    setBusy(true)
    try {
      const result = await api<{
        created: Array<{ name: string }>
        updated: Array<{ name: string; version: string }>
        unchanged: Array<{ name: string }>
        failed: Array<{ path: string; error: string }>
      }>('comfy/workflows', {
        method: 'POST',
        body: JSON.stringify({ action, paths: [chosen.path] }),
      })
      if (result.failed.length > 0) {
        throw new Error(result.failed.map((item) => item.error).join('\n'))
      }
      const updated = result.updated[0]
      const created = result.created[0]
      notify(
        updated
          ? `${updated.name} 的当前版本已覆盖，版本号仍是 ${updated.version}`
          : created
            ? `${created.name} 已入库`
            : `${chosen.name} 已是当前版本`,
      )
      setOpen(false)
      setPicked('')
      await load()
    } catch (err) {
      fail(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    data.set('path', filePath)
    setBusy(true)
    try {
      const saved = await api<{ path: string }>('files', { method: 'POST', body: data })
      notify(`已上传到 input/${saved.path}`)
      setFilePath('')
      form.reset()
      await load()
    } catch (err) {
      fail(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="column-head">
        <div className="tabs" role="tablist">
          {(
            [
              ['input', 'Input'],
              ['output', 'Output'],
              ['workflow', 'Workflow'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? 'active' : ''}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'workflow' ? null : (
          <button
            type="button"
            className="quiet"
            onClick={() => setView((current) => (current === 'list' ? 'grid' : 'list'))}
          >
            {view === 'list' ? '图片' : '列表'}
          </button>
        )}
      </div>
      {tab === 'input' ? (
      <section className="panel">
        <form onSubmit={(event) => void upload(event)}>
          <div className="grid">
            <label>
              文件
              <input
                name="file"
                type="file"
                required
                onChange={(event) => {
                  const name = event.target.files?.[0]?.name
                  if (name) setFilePath(name)
                }}
              />
            </label>
            <label>
              相对路径
              <input value={filePath} onChange={(event) => setFilePath(event.target.value)} />
            </label>
          </div>
          <div className="row">
            <button disabled={busy || filePath.trim() === ''}>上传到 ComfyUI input</button>
          </div>
        </form>
        <FileGrid view={view} files={inputs} empty="input 里还没有文件。" />
      </section>
      ) : null}
      {tab === 'output' ? (
      <section className="panel">
        <FileGrid view={view} files={outputs} empty="output 里还没有文件。" />
      </section>
      ) : null}
      {tab === 'workflow' ? (
      <section className="panel">
        <div className="column-head">
          <h2>Workflow</h2>
          <button
            type="button"
            onClick={() => {
              setPicked('')
              setOpen(true)
            }}
          >
            从 ComfyUI 建立
          </button>
        </div>
        <p className="muted">用 ComfyUI 里的一份 JSON 建立 workflow，或覆盖它的当前版本。</p>
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>Work</th>
              <th>ComfyUI</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {workflows.length === 0 ? (
              <tr>
                <td colSpan={4}>还没有 workflow。</td>
              </tr>
            ) : (
              workflows.map((workflow) => (
                <tr key={workflow.id}>
                  <td>
                    <Link href={`/workflows/${encodeURIComponent(workflow.name)}`}>
                      {workflow.name}
                    </Link>
                  </td>
                  <td>
                    {workflow.works.length === 0
                      ? '—'
                      : workflow.works.map((workName, index) => (
                          <span key={workName}>
                            {index > 0 ? '、' : null}
                            <Link href={`/?work=${encodeURIComponent(workName)}`}>{workName}</Link>
                          </span>
                        ))}
                  </td>
                  <td className="mono">{workflow.comfyPath}</td>
                  <td>
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => {
                        setPicked(workflow.comfyPath)
                        setOpen(true)
                      }}
                    >
                      更新内容
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
      ) : null}
      <Dialog
        open={open}
        title="从 ComfyUI 建立"
        onClose={() => {
          setOpen(false)
        }}
      >
        <p>选一份 ComfyUI JSON。新文件会入库；已入库且内容变了的文件会覆盖当前版本，不产生新版本。</p>
        <table>
          <thead>
            <tr>
              <th>选择</th>
              <th>文件</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {remote.length === 0 ? (
              <tr>
                <td colSpan={3}>ComfyUI 没有工作流。</td>
              </tr>
            ) : (
              remote.map((item) => (
                <tr key={item.path}>
                  <td>
                    <input
                      type="radio"
                      name="comfy-json"
                      checked={picked === item.path}
                      onChange={() => setPicked(item.path)}
                      aria-label={item.path}
                    />
                  </td>
                  <td className="mono">{item.path}</td>
                  <td>{statusLabel(item.status)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <div className="row">
          <button type="button" disabled={busy || action === null} onClick={() => void apply()}>
            {chosen?.status === 'updated'
              ? '覆盖当前版本'
              : chosen?.status === 'unchanged'
                ? '已是当前版本'
                : '入库'}
          </button>
        </div>
      </Dialog>
    </>
  )
}

function FileGrid({
  files,
  empty,
  view,
}: {
  files: LibraryFile[]
  empty: string
  view: 'list' | 'grid'
}) {
  if (files.length === 0) return <p className="muted">{empty}</p>
  if (view === 'list') {
    return (
      <ul className="stack">
        {files.map((file) => (
          <li key={file.path}>
            <a href={mediaHref(file.path)} target="_blank" rel="noreferrer">
              {file.name}
            </a>
          </li>
        ))}
      </ul>
    )
  }
  return (
    <div className="file-grid">
      {files.map((file) => (
        <a key={file.path} href={mediaHref(file.path)} target="_blank" rel="noreferrer">
          {isImage(file.name) ? (
            <img src={mediaHref(file.path)} alt={file.name} loading="lazy" />
          ) : (
            <span className="file-fallback">文件</span>
          )}
          <span>{file.name}</span>
        </a>
      ))}
    </div>
  )
}

function mediaHref(path: string): string {
  return `/api/runner/files/${path.split('/').map(encodeURIComponent).join('/')}`
}

function isImage(name: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(name)
}

function statusLabel(status: ComfyWorkflow['status']): string {
  if (status === 'new') return '新文件'
  if (status === 'updated') return '可覆盖当前版本'
  return '已是当前版本'
}
