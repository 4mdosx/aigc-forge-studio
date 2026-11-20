'use client'

import { useRef, useState } from 'react'

import { setupAccessPin, unlockWithPin } from '@/app/actions/auth'
import { PinInput } from '@/components/pin-input'
import { PIN_LENGTH } from '@/lib/pin-shared'

export function PinAccessForm({ mode }: { mode: 'setup' | 'unlock' }) {
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [pinReset, setPinReset] = useState(0)
  const [confirmReset, setConfirmReset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<Record<string, string[] | undefined>>({})
  const pending = useRef(false)

  const firstError = errors.pin?.[0] || errors.confirmPin?.[0]

  const submitSetup = async (nextPin = pin, nextConfirm = confirmPin) => {
    if (pending.current) return
    if (nextPin.length !== PIN_LENGTH || nextConfirm.length !== PIN_LENGTH) return
    pending.current = true
    setLoading(true)
    setErrors({})
    const result = await setupAccessPin({ pin: nextPin, confirmPin: nextConfirm })
    if (result?.errors) {
      pending.current = false
      setErrors(result.errors)
      setConfirmPin('')
      setConfirmReset((value) => value + 1)
      setLoading(false)
    }
  }

  const submitUnlock = async (nextPin: string) => {
    if (pending.current) return
    if (nextPin.length !== PIN_LENGTH) return
    pending.current = true
    setLoading(true)
    setErrors({})
    const result = await unlockWithPin({ pin: nextPin })
    if (result?.errors) {
      pending.current = false
      setErrors(result.errors)
      setPin('')
      setPinReset((value) => value + 1)
      setLoading(false)
    }
  }

  return (
    <div className="pin-screen">
      <section className="panel pin-card">
        <h1>{mode === 'setup' ? '设置访问 PIN' : '输入 PIN'}</h1>
        <p className="muted">
          {mode === 'setup'
            ? `首次使用请设置 ${PIN_LENGTH} 位 PIN。解锁后当天有效，次日需再输入。`
            : `输入 ${PIN_LENGTH} 位 PIN。解锁后当天有效。`}
        </p>
        <p className="pin-hint">PIN 输错会触发指数退避：越错等得越久，最长锁 24 小时。</p>
        <div className="pin-fields">
          {mode === 'setup' ? (
            <>
              <div>
                <span className="pin-label">新 PIN</span>
                <PinInput
                  key={`pin-${pinReset}`}
                  disabled={loading}
                  onChange={setPin}
                  onComplete={(value) => {
                    setPin(value)
                    if (confirmPin.length === PIN_LENGTH) {
                      void submitSetup(value, confirmPin)
                      return
                    }
                    document.getElementById('pin-confirm')?.focus()
                  }}
                />
              </div>
              <div>
                <span className="pin-label">确认 PIN</span>
                <PinInput
                  id="pin-confirm"
                  key={`confirm-${confirmReset}`}
                  autoFocus={false}
                  disabled={loading}
                  onChange={setConfirmPin}
                  onComplete={(value) => {
                    setConfirmPin(value)
                    if (pin.length === PIN_LENGTH) void submitSetup(pin, value)
                  }}
                />
              </div>
              <button
                type="button"
                className="pin-submit"
                disabled={loading || pin.length !== PIN_LENGTH || confirmPin.length !== PIN_LENGTH}
                onClick={() => void submitSetup()}
              >
                {loading ? '保存中…' : '保存 PIN'}
              </button>
            </>
          ) : (
            <>
              <PinInput
                key={`unlock-${pinReset}`}
                disabled={loading}
                onChange={setPin}
                onComplete={(value) => {
                  setPin(value)
                  void submitUnlock(value)
                }}
              />
              {loading ? <p className="muted">验证中…</p> : null}
            </>
          )}
        </div>
        {firstError ? <p className="pin-error">{firstError}</p> : null}
      </section>
    </div>
  )
}
