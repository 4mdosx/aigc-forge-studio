import type { TaskResult } from '../src/adapter.ts'
import { removeBg } from './remove-bg.ts'
import { text2img } from './text2img.ts'

export async function cutout(input: {
  text: string
  entry?: string
  adapter?: string
}): Promise<TaskResult> {
  const generated = await text2img({
    text: input.text,
    entry: input.entry ?? 'sdxl',
  })
  return removeBg({
    path: generated.path,
    adapter: input.adapter ?? 'birefnet',
  })
}
