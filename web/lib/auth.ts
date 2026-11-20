import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'

import {
  clearSignal,
  describeRemaining,
  describeSignal,
  lockedFor,
  recordFailure,
  recordFailureSignal,
  recordSuccess,
} from './backoff'
import {
  getPinEpoch,
  isPinConfigured,
  readAuth,
  savePin,
  sessionSecret,
  verifyStoredPin,
} from './auth-store'
import { isPin, pinLengthMessage, type PinFieldErrors } from './pin-shared'
import { endOfLocalDay, readSession, signSession } from './session'

export type PinResult = { ok: true } | { ok: false; errors: PinFieldErrors }

export class PinLockError extends Error {
  readonly remainingMs: number

  constructor(message: string, remainingMs: number) {
    super(message)
    this.name = 'PinLockError'
    this.remainingMs = remainingMs
  }
}

function fail(field: string, message: string): PinResult {
  return { ok: false, errors: { [field]: [message] } }
}

function fieldsOf(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {}
  return input as Record<string, unknown>
}

async function clientKey(): Promise<string> {
  const requestHeaders = await headers()
  const forwarded = requestHeaders.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return requestHeaders.get('x-real-ip')?.trim() || 'local'
}

function assertNotRateLimited(key: string): void {
  const remaining = lockedFor(key)
  if (remaining <= 0) return
  throw new PinLockError(describeRemaining(remaining), remaining)
}

function recordLoginFailure(key: string): void {
  recordFailure(key)
  const signal = recordFailureSignal(key)
  if (signal.suspicious) console.warn(describeSignal(signal, key))
}

function recordLoginSuccess(key: string): void {
  recordSuccess(key)
  clearSignal(key)
}

export async function verifySession() {
  const cookie = (await cookies()).get('session')?.value
  const auth = readAuth()
  if (!cookie || !auth.hash || !auth.epoch || !auth.secret) {
    return { isAuth: false as const }
  }
  const session = readSession(cookie, auth.secret)
  if (!session || session.pinEpoch !== auth.epoch) {
    return { isAuth: false as const }
  }
  return {
    isAuth: true as const,
    expiresAt: new Date(session.exp),
    pinEpoch: session.pinEpoch,
  }
}

export async function requireAppAccess() {
  if (!isPinConfigured()) redirect('/login')
  const session = await verifySession()
  if (!session.isAuth) redirect('/login')
  return session
}

export async function createSession() {
  const pinEpoch = getPinEpoch()
  if (!pinEpoch) throw new Error('PIN 未设置')
  const expiresAt = endOfLocalDay()
  const token = signSession({ exp: expiresAt.getTime(), pinEpoch }, sessionSecret())
  const jar = await cookies()
  jar.set('session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    expires: expiresAt,
    sameSite: 'lax',
    path: '/',
  })
}

export async function deleteSession() {
  ;(await cookies()).delete('session')
}

export async function setupPin(input: unknown): Promise<PinResult> {
  const key = await clientKey()
  assertNotRateLimited(key)
  if (isPinConfigured()) return fail('pin', 'PIN 已设置，请直接解锁')

  const fields = fieldsOf(input)
  if (!isPin(fields.pin)) return fail('pin', pinLengthMessage())
  if (!isPin(fields.confirmPin)) return fail('confirmPin', pinLengthMessage())
  if (fields.pin !== fields.confirmPin) return fail('confirmPin', '两次 PIN 不一致')

  await savePin(fields.pin)
  recordLoginSuccess(key)
  await createSession()
  return { ok: true }
}

export async function loginWithPin(input: unknown): Promise<PinResult> {
  const key = await clientKey()
  assertNotRateLimited(key)
  if (!isPinConfigured()) return fail('pin', '尚未设置 PIN')

  const fields = fieldsOf(input)
  if (!isPin(fields.pin)) return fail('pin', pinLengthMessage())

  const valid = await verifyStoredPin(fields.pin)
  if (!valid) {
    recordLoginFailure(key)
    return fail('pin', 'PIN 不正确')
  }

  recordLoginSuccess(key)
  await createSession()
  return { ok: true }
}

export async function updatePin(input: unknown): Promise<PinResult> {
  const key = await clientKey()
  assertNotRateLimited(key)
  const session = await verifySession()
  if (!session.isAuth) return fail('currentPin', '请先解锁')
  if (!isPinConfigured()) return fail('currentPin', '尚未设置 PIN')

  const fields = fieldsOf(input)
  if (!isPin(fields.currentPin)) return fail('currentPin', pinLengthMessage())
  if (!isPin(fields.pin)) return fail('pin', pinLengthMessage())
  if (!isPin(fields.confirmPin)) return fail('confirmPin', pinLengthMessage())
  if (fields.pin !== fields.confirmPin) return fail('confirmPin', '两次 PIN 不一致')

  const valid = await verifyStoredPin(fields.currentPin)
  if (!valid) {
    recordLoginFailure(key)
    return fail('currentPin', '当前 PIN 不正确')
  }

  await savePin(fields.pin)
  recordLoginSuccess(key)
  await createSession()
  return { ok: true }
}
