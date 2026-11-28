'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export function Nav() {
  const path = usePathname()
  const home = path === '/' || path.startsWith('/tasks')
  const poses = path.startsWith('/poses')
  const capture = path.startsWith('/capture')
  const jobs = path.startsWith('/jobs')
  const train = path.startsWith('/train')
  const dice = path.startsWith('/dice')
  const library = path.startsWith('/library') || path.startsWith('/workflows')
  const settings = path.startsWith('/settings')
  const blender = path.startsWith('/blender')
  return (
    <nav>
      <Link className={home ? 'active' : ''} href="/">
        生图
      </Link>
      <Link className={poses ? 'active' : ''} href="/poses">
        Pose
      </Link>
      <Link className={capture ? 'active' : ''} href="/capture">
        Capture
      </Link>
      <Link className={jobs ? 'active' : ''} href="/jobs">
        Jobs
      </Link>
      <Link className={train ? 'active' : ''} href="/train">
        训练
      </Link>
      <Link className={dice ? 'active' : ''} href="/dice">
        🎲 Dice
      </Link>
      <Link className={library ? 'active' : ''} href="/library">
        Library
      </Link>
      <Link className={settings ? 'active' : ''} href="/settings">
        设置
      </Link>
      <Link className={blender ? 'active' : ''} href="/blender">
        Blender
      </Link>
    </nav>
  )
}
