import type { Metadata } from 'next'

import { BlenderWorkbench } from '@/blender/components/blender-workbench'

export const metadata: Metadata = {
  title: 'Blender Workbench · GOF',
  description: 'Blender 插件工作台',
}

export const dynamic = 'force-dynamic'

export default function Page() {
  return <BlenderWorkbench />
}
