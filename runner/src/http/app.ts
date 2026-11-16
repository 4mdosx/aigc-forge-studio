import { Hono } from 'hono'

import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'
import { mountChats } from './chats.ts'
import { mountData } from './data.ts'
import { mountFiles } from './files.ts'
import { mountPoses } from './poses.ts'
import { mountPosePending } from './pose-pending.ts'
import { mountTasks } from './tasks.ts'
import { mountWorkflows } from './workflows.ts'
import { mountWorks } from './works.ts'

export function createApp(runner: Runner): Hono {
  const app = new Hono()
  app.onError((err, c) => {
    const status = err instanceof RunnerError ? err.status : 500
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, status as 400)
  })
  app.notFound((c) => c.json({ error: 'not found' }, 404))
  mountWorks(app, runner)
  mountWorkflows(app, runner)
  mountTasks(app, runner)
  mountChats(app, runner)
  mountFiles(app, runner)
  mountData(app, runner)
  mountPoses(app, runner)
  mountPosePending(app, runner)
  return app
}
