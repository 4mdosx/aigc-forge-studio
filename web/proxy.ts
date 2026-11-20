import { NextResponse, type NextRequest } from 'next/server'

import { readAuth } from './lib/auth-store'
import { gateDecision, isPublicPath } from './lib/gate'

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname
  if (isPublicPath(pathname)) return NextResponse.next()
  const decision = gateDecision(pathname, request.cookies.get('session')?.value, readAuth())
  if (decision === 'allow') return NextResponse.next()
  return deny(request)
}

function deny(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const url = request.nextUrl.clone()
  url.pathname = '/login'
  url.search = ''
  return NextResponse.redirect(url)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|ttf|woff2?)$).*)',
  ],
}
