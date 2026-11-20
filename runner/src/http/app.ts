import { Hono } from 'hono'

import { CaptureLive } from '../capture/live.ts'
import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'
import { mountCapture } from './capture.ts'
import { mountCaptureLive } from './live.ts'
import { mountConfig } from './config.ts'
import { mountDice } from './dice.ts'
import { mountChats } from './chats.ts'
import { mountData } from './data.ts'
import { mountDatasets } from './datasets.ts'
import { mountFiles } from './files.ts'
import { mountPoses } from './poses.ts'
import { mountPosePending } from './pose-pending.ts'
import { mountRecommend } from './recommend.ts'
import { mountTag } from './tag.ts'
import { mountTasks } from './tasks.ts'
import { mountTrain } from './train.ts'
import { mountWorkflows } from './workflows.ts'
import { mountWorks } from './works.ts'

export function createApp(
  runner: Runner,
  live: CaptureLive = new CaptureLive(),
): Hono {
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
  mountCapture(app, runner)
  mountCaptureLive(app, live)
  mountDatasets(app, runner)
  mountDice(app, runner)
  mountConfig(app, runner)
  mountTag(app, runner)
  mountRecommend(app, runner)
  mountTrain(app, runner)
  return app
}
