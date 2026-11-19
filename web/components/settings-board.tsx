'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'

import { api } from '@/lib/api'
import { fail, messageOf, notify } from '@/lib/notify'

interface RollConfig {
  workflowName: string
  version: string
  step: string
  workflowPositive: string
  workflowNegative: string
}

const empty: RollConfig = {
  workflowName: '',
  version: '',
  step: '',
  workflowPositive: '',
  workflowNegative: '',
}

export function SettingsBoard() {
  const [form, setForm] = useState<RollConfig>(empty)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const body = await api<{ value: RollConfig }>('config/roll_config')
      setForm({ ...empty, ...body.value })
    } catch (err) {
      fail(messageOf(err))
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function setField(key: keyof RollConfig, value: string) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    try {
      const body = await api<{ value: RollConfig }>('config/roll_config', {
        method: 'PUT',
        body: JSON.stringify(form),
      })
      setForm({ ...empty, ...body.value })
      notify('已保存 roll_config')
    } catch (err) {
      fail(messageOf(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="panel">
      <h2>出图设置</h2>
      <p className="muted">
        存成 config 表的 roll_config。Dice 出图用这里的工作流、step，并把固定正负向拼在灵感 prompt 前面。version 留空则用该工作流的 main。工作流需要挂在 work baseline 上。
      </p>
      {loaded ? (
        <form onSubmit={(event) => void save(event)}>
          <div className="grid">
            <label>
              workflowName
              <input
                value={form.workflowName}
                onChange={(event) => setField('workflowName', event.target.value)}
                required
              />
            </label>
            <label>
              version
              <input
                value={form.version}
                onChange={(event) => setField('version', event.target.value)}
                placeholder="空则用 main"
              />
            </label>
            <label>
              step
              <input
                value={form.step}
                onChange={(event) => setField('step', event.target.value)}
                required
              />
            </label>
          </div>
          <div className="grid">
            <label>
              workflowPositive
              <textarea
                className="prose"
                value={form.workflowPositive}
                onChange={(event) => setField('workflowPositive', event.target.value)}
              />
            </label>
            <label>
              workflowNegative
              <textarea
                className="prose"
                value={form.workflowNegative}
                onChange={(event) => setField('workflowNegative', event.target.value)}
              />
            </label>
          </div>
          <div className="row">
            <button type="submit" disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      ) : (
        <p className="muted">读取中…</p>
      )}
    </section>
  )
}
