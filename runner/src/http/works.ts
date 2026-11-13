import type { Hono } from 'hono'

import type { Runner } from '../task/queue.ts'
import {
  attachWorkflow,
  createWork,
  updateSemantic,
  workByName,
  workflowsOf,
} from '../work/works.ts'
import { jsonObject, stringField } from './request.ts'

export function mountWorks(app: Hono, runner: Runner): void {
  app.get('/works', (c) => {
    const rows = runner.db
      .prepare('SELECT * FROM works ORDER BY name')
      .all() as unknown as Array<{
      id: string
      name: string
      semantic_json: string
      created_at: string
    }>
    return c.json({
      works: rows.map((row) => ({
        id: row.id,
        name: row.name,
        semantic: JSON.parse(row.semantic_json) as unknown,
        createdAt: row.created_at,
        workflows: workflowsOf(runner.db, row.id).map((workflow) => ({
          id: workflow.id,
          name: workflow.name,
          comfyPath: workflow.comfy_path,
        })),
      })),
    })
  })

  app.post('/works', async (c) => {
    const body = await jsonObject(c.req)
    const work = createWork(
      runner.db,
      stringField(body, 'name'),
      body.semantic,
      runner.now(),
    )
    return c.json({ id: work.id, name: work.name }, 201)
  })

  app.get('/works/:name', (c) => {
    const work = workByName(runner.db, c.req.param('name'))
    return c.json({
      id: work.id,
      name: work.name,
      semantic: JSON.parse(work.semantic_json) as unknown,
      createdAt: work.created_at,
      workflows: workflowsOf(runner.db, work.id).map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        comfyPath: workflow.comfy_path,
        hasAdapter: workflow.adapter_json !== null,
      })),
    })
  })

  app.post('/works/:name/semantic', async (c) => {
    const body = await jsonObject(c.req)
    const work = updateSemantic(runner.db, c.req.param('name'), body.semantic)
    return c.json({
      name: work.name,
      semantic: JSON.parse(work.semantic_json) as unknown,
    })
  })

  app.post('/works/:name/workflows', async (c) => {
    const body = await jsonObject(c.req)
    const workflow = attachWorkflow(
      runner.db,
      c.req.param('name'),
      stringField(body, 'workflowName'),
    )
    return c.json({ name: workflow.name, workId: workflow.work_id })
  })
}
