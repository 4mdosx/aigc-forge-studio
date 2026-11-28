import type { ReactNode } from 'react'
import Link from 'next/link'

import { Nav } from '@/components/nav'
import { requireAppAccess } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export default async function StudioLayout({ children }: { children: ReactNode }) {
  await requireAppAccess()
  return (
    <div className="shell">
      <header className="top">
        <Link className="mark" href="/">
          GOF<span>go forge</span>
        </Link>
        <Nav />
      </header>
      {children}
    </div>
  )
}
