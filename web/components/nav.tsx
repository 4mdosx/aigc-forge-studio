'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export function Nav() {
  const path = usePathname()
  const work = path === '/' || path.startsWith('/tasks')
  const library = path.startsWith('/library') || path.startsWith('/workflows')
  return (
    <nav>
      <Link className={work ? 'active' : ''} href="/">
        Work
      </Link>
      <Link className={library ? 'active' : ''} href="/library">
        Library
      </Link>
    </nav>
  )
}
