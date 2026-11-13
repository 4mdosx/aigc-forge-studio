import type { ReactNode } from 'react'
import Link from 'next/link'

import { Nav } from '@/components/nav'

import './globals.css'

export const metadata = {
  title: 'AIGC',
  description: 'Runner workflows and tasks',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="shell">
          <header className="top">
            <Link className="mark" href="/">
              AIGC<span>Runner</span>
            </Link>
            <Nav />
          </header>
          {children}
        </div>
      </body>
    </html>
  )
}
