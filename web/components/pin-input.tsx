'use client'

import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'

import { PIN_LENGTH } from '@/lib/pin-shared'

export function PinInput({
  id,
  autoFocus = true,
  disabled = false,
  compact = false,
  onChange,
  onComplete,
}: {
  id?: string
  autoFocus?: boolean
  disabled?: boolean
  compact?: boolean
  onChange?: (code: string) => void
  onComplete?: (code: string) => void
}) {
  const [code, setCode] = useState<string[]>(() => Array(PIN_LENGTH).fill(''))
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])
  const codeRef = useRef(code)
  const handlers = useRef({ onChange, onComplete })
  handlers.current = { onChange, onComplete }

  const publish = (nextCode: string[]) => {
    codeRef.current = nextCode
    setCode(nextCode)
    const value = nextCode.join('')
    handlers.current.onChange?.(value)
    if (value.length === PIN_LENGTH && nextCode.every(Boolean)) handlers.current.onComplete?.(value)
  }

  const writeAt = (index: number, digit: string) => {
    const nextCode = [...codeRef.current]
    nextCode[index] = digit
    publish(nextCode)
  }

  const focusAt = (index: number) => {
    inputRefs.current[index]?.focus()
    inputRefs.current[index]?.select()
  }

  const onDigit = (index: number, raw: string) => {
    if (!/^\d*$/.test(raw)) return
    const digit = raw.slice(-1)
    writeAt(index, digit)
    if (digit && index < PIN_LENGTH - 1) focusAt(index + 1)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault()
      focusAt(index - 1)
      return
    }
    if (event.key === 'ArrowRight' && index < PIN_LENGTH - 1) {
      event.preventDefault()
      focusAt(index + 1)
      return
    }
    if (event.key === 'Backspace' && !code[index] && index > 0) {
      event.preventDefault()
      writeAt(index - 1, '')
      focusAt(index - 1)
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault()
    const pasted = event.clipboardData.getData('text/plain').trim()
    if (!/^\d+$/.test(pasted)) return
    const nextCode = Array(PIN_LENGTH).fill('')
    for (let i = 0; i < Math.min(PIN_LENGTH, pasted.length); i += 1) nextCode[i] = pasted[i]
    publish(nextCode)
    focusAt(Math.min(pasted.length, PIN_LENGTH) - 1)
  }

  useEffect(() => {
    if (!autoFocus || disabled) return
    inputRefs.current[0]?.focus()
  }, [autoFocus, disabled])

  return (
    <div className={compact ? 'pin-row compact' : 'pin-row'}>
      {code.map((digit, index) => (
        <input
          key={index}
          id={index === 0 ? id : undefined}
          ref={(node) => {
            inputRefs.current[index] = node
          }}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={1}
          value={digit}
          disabled={disabled}
          aria-label={`PIN 第 ${index + 1} 位`}
          onChange={(event) => onDigit(index, event.target.value)}
          onKeyDown={(event) => onKeyDown(event, index)}
          onFocus={() => inputRefs.current[index]?.select()}
          onPaste={index === 0 ? onPaste : undefined}
          autoFocus={autoFocus && index === 0}
        />
      ))}
    </div>
  )
}
