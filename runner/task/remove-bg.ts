import { runTask, type TaskResult } from '../src/adapter.ts'

export function removeBg(input: { path: string; adapter: string }): Promise<TaskResult> {
  return runTask('remove-bg', input.adapter, { path: input.path })
}
