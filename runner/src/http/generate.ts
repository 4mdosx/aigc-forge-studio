import type { Context, Hono } from 'hono'

import { taskById } from '../db.ts'
import { createGeneration, parseGenerateInput, type GenerateKind } from '../generate.ts'
import type { Runner } from '../task/queue.ts'
import { jsonObject, taskJson } from './request.ts'

// 生产接口：参数只收 prompt/repeat/loraName（cn 额外 poseName）。
// workflow 名、adapter、版本选择全在服务端代码里，前端不可见。
export function mountGenerate(app: Hono, runner: Runner): void {
  const handle = (kind: GenerateKind) => async (c: Context) => {
    const body = await jsonObject(c.req)
    const input = parseGenerateInput(kind, body)
    const { jobId } = await createGeneration(runner, kind, input)
    const job = taskById(runner.db, jobId)
    return c.json(taskJson(runner.db, job), 201)
  }

  app.post('/generate/cn', handle('cn'))
  app.post('/generate/base', handle('base'))
}
