import { runTask, type TaskResult } from '../src/adapter.ts'

export function text2img(input: { text: string; entry: string }): Promise<TaskResult> {
  return runTask('text2img', input.entry, { text: input.text })
}
