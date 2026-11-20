import type { ReactNode } from 'react'

import { Notices } from '@/components/notices'
import { OverlayScrollbars } from '@/components/overlay-scrollbars'

import './globals.css'

export const metadata = {
  title: 'AIGC',
  description: 'Runner workflows and tasks',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <OverlayScrollbars />
        {children}
        <Notices />
      </body>
    </html>
  )
}
