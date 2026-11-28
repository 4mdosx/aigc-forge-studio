'use client'

import { useCallback, useEffect, useState } from 'react'

import { api } from '@/lib/api'
import { fail, messageOf } from '@/lib/notify'

export function isSafetyHiddenRating(rating: string | undefined): boolean {
  return rating === 'questionable' || rating === 'explicit'
}

export function useSafetyMode() {
  const [enabled, setEnabled] = useState(false)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let stop = false
    api<{ value: { enabled: boolean } }>('config/safety_mode')
      .then((body) => {
        if (!stop) setEnabled(body.value.enabled)
      })
      .catch((err: unknown) => {
        if (!stop) fail(messageOf(err))
      })
      .finally(() => {
        if (!stop) setReady(true)
      })
    return () => {
      stop = true
    }
  }, [])

  const setSafety = useCallback(async (next: boolean) => {
    setSaving(true)
    setEnabled(next)
    try {
      const body = await api<{ value: { enabled: boolean } }>('config/safety_mode', {
        method: 'PUT',
        body: JSON.stringify({ enabled: next }),
      })
      setEnabled(body.value.enabled)
    } catch (err) {
      setEnabled((current) => (current === next ? !next : current))
      fail(messageOf(err))
    } finally {
      setSaving(false)
    }
  }, [])

  return { enabled, ready, saving, setSafety }
}
