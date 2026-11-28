import { createHmac, timingSafeEqual } from 'node:crypto'

export type SessionClaims = {
  exp: number
  pinEpoch: string
}

export function endOfLocalDay(now = new Date()): Date {
  const expiresAt = new Date(now)
  expiresAt.setHours(24, 0, 0, 0)
  return expiresAt
}

export function signSession(claims: SessionClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function readSession(token: string | undefined, secret: string): SessionClaims | null {
  if (!token || !secret) return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  const got = Buffer.from(sig)
  const want = Buffer.from(expected)
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<SessionClaims>
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null
    if (payload.exp <= Date.now()) return null
    if (typeof payload.pinEpoch !== 'string' || payload.pinEpoch.length === 0) return null
    return { exp: payload.exp, pinEpoch: payload.pinEpoch }
  } catch {
    return null
  }
}

export function sessionMatches(
  token: string | undefined,
  secret: string,
  epoch: string,
): boolean {
  const claims = readSession(token, secret)
  return claims?.pinEpoch === epoch
}
