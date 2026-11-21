'use client'

import { QuickGenerate } from '@/components/quick-generate'

// 首页只保留快速生图；Work 及其附属 UI（详情/出图/对话/任务坞）已移至 library 的 Work tab。
export function HomeBoard() {
  return (
    <div className="home">
      <QuickGenerate />
    </div>
  )
}
