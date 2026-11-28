'use server'

import { redirect } from 'next/navigation'

import { deleteSession, loginWithPin, PinLockError, setupPin, updatePin } from '@/lib/auth'
import type { PinFieldErrors } from '@/lib/pin-shared'

function toErrors(error: unknown): { errors: PinFieldErrors } {
  if (error instanceof PinLockError) return { errors: { pin: [error.message] } }
  throw error
}

export async function setupAccessPin(input: { pin: string; confirmPin: string }) {
  try {
    const result = await setupPin(input)
    if (!result.ok) return { errors: result.errors }
  } catch (error) {
    return toErrors(error)
  }
  redirect('/')
}

export async function unlockWithPin(input: { pin: string }) {
  try {
    const result = await loginWithPin(input)
    if (!result.ok) return { errors: result.errors }
  } catch (error) {
    return toErrors(error)
  }
  redirect('/')
}

export async function updateAccessPin(input: {
  currentPin: string
  pin: string
  confirmPin: string
}) {
  try {
    const result = await updatePin(input)
    if (!result.ok) return { errors: result.errors }
    return { ok: true as const }
  } catch (error) {
    return toErrors(error)
  }
}

export async function logout() {
  await deleteSession()
  redirect('/login')
}
