'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { logout, updateAccessPin } from '@/app/actions/auth'
import { PinInput } from '@/components/pin-input'
import { PIN_LENGTH } from '@/lib/pin-shared'

export function PinSettings({ updatedLabel }: { updatedLabel: string | null }) {
  const router = useRouter()
  const [currentPin, setCurrentPin] = useState('')
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [formKey, setFormKey] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string[] | undefined>>({})

  const firstError = errors.currentPin?.[0] || errors.pin?.[0] || errors.confirmPin?.[0]
  const canSubmit =
    currentPin.length === PIN_LENGTH &&
    pin.length === PIN_LENGTH &&
    confirmPin.length === PIN_LENGTH

  async function onSubmit() {
    if (!canSubmit || loading) return
    setLoading(true)
    setErrors({})
    setMessage(null)
    const result = await updateAccessPin({ currentPin, pin, confirmPin })
    if (result && 'errors' in result && result.errors) {
      setErrors(result.errors)
    } else {
      setMessage('PIN 已更新')
      setCurrentPin('')
      setPin('')
      setConfirmPin('')
      setFormKey((value) => value + 1)
      router.refresh()
    }
    setLoading(false)
  }

  return (
    <section className="panel pin-settings">
      <h2>访问 PIN</h2>
      <p className="muted">
        解锁后当天有效，过了零点需要重新输入。退出后立即失效。
        {updatedLabel ? ` 上次更新于 ${updatedLabel}。` : ''}
      </p>
      <div key={formKey} className="pin-fields">
        <div>
          <span className="pin-label">当前 PIN</span>
          <PinInput compact autoFocus={false} disabled={loading || loggingOut} onChange={setCurrentPin} />
        </div>
        <div>
          <span className="pin-label">新 PIN</span>
          <PinInput compact autoFocus={false} disabled={loading || loggingOut} onChange={setPin} />
        </div>
        <div>
          <span className="pin-label">确认新 PIN</span>
          <PinInput compact autoFocus={false} disabled={loading || loggingOut} onChange={setConfirmPin} />
        </div>
      </div>
      <div className="row">
        <button type="button" disabled={loading || loggingOut || !canSubmit} onClick={() => void onSubmit()}>
          {loading ? '保存中…' : '更新 PIN'}
        </button>
        <button
          type="button"
          className="quiet"
          disabled={loading || loggingOut}
          onClick={() => {
            setLoggingOut(true)
            void logout()
          }}
        >
          {loggingOut ? '退出中…' : '退出登录'}
        </button>
      </div>
      {firstError ? <p className="pin-error">{firstError}</p> : null}
      {message ? <p className="note">{message}</p> : null}
    </section>
  )
}
