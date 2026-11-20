import { sessionMatches } from './session.ts'

const PUBLIC_PATHS = new Set(['/login'])

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname)
}

export function gateDecision(
  pathname: string,
  cookie: string | undefined,
  auth: { hash?: string; epoch?: string; secret?: string },
): 'allow' | 'deny' {
  if (isPublicPath(pathname)) return 'allow'
  if (!auth.hash || !auth.epoch || !auth.secret) return 'deny'
  if (!sessionMatches(cookie, auth.secret, auth.epoch)) return 'deny'
  return 'allow'
}
