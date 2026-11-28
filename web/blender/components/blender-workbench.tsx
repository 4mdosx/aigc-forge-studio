'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

import { ApiError, runnerApi } from '@/lib/api'
import type {
  PluginDetail,
  PluginSummary,
  RunRecord,
  ScenesPayload,
  StatusPayload,
} from '@/lib/types'

export function BlenderWorkbench() {
  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [plugins, setPlugins] = useState<PluginSummary[]>([])
  const [scenes, setScenes] = useState<ScenesPayload | null>(null)
  const [detail, setDetail] = useState<PluginDetail | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [scene, setScene] = useState<string>('')
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [currentRun, setCurrentRun] = useState<RunRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refreshMeta = useCallback(async () => {
    try {
      const [nextStatus, nextPlugins, nextScenes, nextRuns] = await Promise.all([
        runnerApi<StatusPayload>('blender/status'),
        runnerApi<{ plugins: PluginSummary[] }>('blender/plugins'),
        runnerApi<ScenesPayload>('blender/scenes'),
        runnerApi<{ runs: RunRecord[] }>('blender/runs?limit=10'),
      ])
      setStatus(nextStatus)
      setPlugins(nextPlugins.plugins)
      setScenes(nextScenes)
      setRuns(nextRuns.runs)
      setScene((prev) => prev || nextScenes.active || '')
      setActiveId((prev) => prev ?? nextPlugins.plugins[0]?.id ?? null)
      setError('')
    } catch (err) {
      setError(messageOf(err))
    }
  }, [])

  useEffect(() => {
    void refreshMeta()
  }, [refreshMeta])

  const selectPlugin = useCallback(async (id: string) => {
    setActiveId(id)
    setError('')
    try {
      const next = await runnerApi<PluginDetail>(
        `blender/plugins/${encodeURIComponent(id)}`,
      )
      setDetail(next)
      setActiveFile(next.manifest.entry)
      const defaults: Record<string, unknown> = {}
      for (const [key, spec] of Object.entries(next.manifest.variables)) {
        defaults[key] = spec.default
      }
      setValues(defaults)
    } catch (err) {
      setError(messageOf(err))
    }
  }, [])

  useEffect(() => {
    if (activeId) void selectPlugin(activeId)
  }, [activeId, selectPlugin])

  const activeSource = useMemo(
    () => detail?.sources.find((item) => item.path === activeFile) ?? null,
    [detail, activeFile],
  )

  async function run(): Promise<void> {
    if (!activeId || busy) return
    setBusy(true)
    setError('')
    try {
      const record = await runnerApi<RunRecord>('blender/run', {
        method: 'POST',
        body: JSON.stringify({
          pluginId: activeId,
          scene: scene || null,
          variables: values,
        }),
      })
      setCurrentRun(record)
      await refreshMeta()
    } catch (err) {
      const detail = err instanceof ApiError ? err : null
      setError(messageOf(err))
      if (detail) setCurrentRun(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="shell">
      <header className="top">
        <a className="brand" href="http://127.0.0.1:3000">
          GOF <small>Blender Workbench</small>
        </a>
        <span className={status?.connected ? 'status' : 'status off'}>
          {status?.connected
            ? `Blender 已连接 · ${status.activeScene ?? '无 Scene'}`
            : 'Blender 未连接'}
        </span>
        <button className="quiet" onClick={() => void refreshMeta()}>
          刷新
        </button>
        <span className="hint">源码在 data/blender-plugin，工作台只读</span>
      </header>

      {error && <p className="error">{error}</p>}
      {status?.error && <p className="error">{status.error}</p>}

      <div className="layout">
        <section className="panel">
          <div className="panel-head">
            <h2>Plugins</h2>
            <span className="count">{plugins.length}</span>
          </div>
          <div className="panel-body">
            {plugins.length === 0 && <p className="empty">未发现插件</p>}
            {plugins.map((item) => (
              <button
                key={item.id}
                className={item.id === activeId ? 'item active' : 'item'}
                onClick={() => setActiveId(item.id)}
              >
                {item.name}
                <small>{item.description}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Code</h2>
            <div className="tabs">
              {detail?.sources.map((item) => (
                <button
                  key={item.path}
                  className={item.path === activeFile ? 'tab active' : 'tab'}
                  onClick={() => setActiveFile(item.path)}
                >
                  {item.path.split('/').at(-1)}
                </button>
              ))}
            </div>
          </div>
          <pre className="code">
            {activeSource
              ? activeSource.content.split('\n').map((line, index) => (
                  <div className="line" key={index}>
                    <span className="num">{index + 1}</span>
                    <span className="src">{line}</span>
                  </div>
                ))
              : '// 选择插件查看源码'}
          </pre>
        </section>

        <section className="panel inspector">
          <div className="panel-head">
            <h2>Run</h2>
            {detail && <span className="count">{detail.manifest.entry}</span>}
          </div>
          <div className="panel-body">
            <div className="field">
              <label>
                <span>Scene</span>
                <span>{scenes?.filepath || '当前 .blend'}</span>
              </label>
              <select value={scene} onChange={(e) => setScene(e.target.value)}>
                <option value="">（当前 Scene）</option>
                {scenes?.scenes.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                    {item.active ? ' · active' : ''}
                  </option>
                ))}
                {scenes?.templates.map((item) => (
                  <option key={`t-${item.name}`} value={item.name}>
                    模板: {item.name}
                  </option>
                ))}
              </select>
            </div>

            {Object.entries(detail?.manifest.variables ?? {}).map(([key, spec]) => (
              <div className="field" key={key}>
                <label>
                  <span>{spec.label ?? key}</span>
                  <span>{spec.type}</span>
                </label>
                {spec.type === 'boolean' ? (
                  <div className="checkbox">
                    <input
                      type="checkbox"
                      checked={values[key] === true}
                      onChange={(e) =>
                        setValues((prev) => ({ ...prev, [key]: e.target.checked }))
                      }
                    />
                    <span>{values[key] === true ? 'true' : 'false'}</span>
                  </div>
                ) : spec.type === 'select' ? (
                  <select
                    value={String(values[key] ?? '')}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                  >
                    {(spec.options ?? []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={spec.type === 'number' ? 'number' : 'text'}
                    value={String(values[key] ?? '')}
                    min={spec.min}
                    max={spec.max}
                    step={spec.step}
                    onChange={(e) =>
                      setValues((prev) => ({
                        ...prev,
                        [key]:
                          spec.type === 'number' ? Number(e.target.value) : e.target.value,
                      }))
                    }
                  />
                )}
              </div>
            ))}

            <button
              className="primary"
              disabled={!activeId || busy || !status?.connected}
              onClick={() => void run()}
            >
              {busy ? '运行中…' : '运行'}
            </button>

            {currentRun && (
              <>
                <p className="run-meta">
                  {currentRun.id} · {currentRun.status}
                </p>
                <pre className="log">
                  {currentRun.error ?? currentRun.log ?? '（无输出）'}
                </pre>
              </>
            )}

            {runs.length > 0 && (
              <>
                <div className="panel-head" style={{ padding: '0.8rem 0 0.3rem' }}>
                  <h2>Recent runs</h2>
                </div>
                {runs.map((item) => (
                  <button
                    key={item.id}
                    className="item"
                    onClick={() => setCurrentRun(item)}
                  >
                    {item.id}
                    <small>
                      {item.pluginId} · {item.status} · {item.createdAt.slice(11, 19)}
                    </small>
                  </button>
                ))}
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
