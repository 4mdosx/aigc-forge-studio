import type { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'

import type { Runner } from '../task/queue.ts'
import { adapterFit, suggestAdapter } from '../workflow/binding.ts'
import type { Prompt } from '../workflow/graph.ts'
import {
  attachWorkflow,
  createWork,
  detachWorkflow,
  linksOf,
  readAdapterMap,
  resolveAdapter,
  saveAdapter,
  updateSemantic,
  workByName,
  type WorkLink,
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
        workflows: linksOf(runner.db, row.id).map((link) => ({
          id: link.id,
          name: link.name,
          comfyPath: link.comfy_path,
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
      workflows: linksOf(runner.db, work.id).map((link) =>
        linkJson(runner.db, link),
      ),
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

  app.post('/works/:name/workflows/detach', async (c) => {
    const body = await jsonObject(c.req)
    const workflow = detachWorkflow(
      runner.db,
      c.req.param('name'),
      stringField(body, 'workflowName'),
    )
    return c.json({ name: workflow.name })
  })

  app.post('/works/:name/workflows/adapter', async (c) => {
    const body = await jsonObject(c.req)
    const version = stringField(body, 'version')
    const adapter = saveAdapter(
      runner.db,
      c.req.param('name'),
      stringField(body, 'workflowName'),
      version,
      body.adapter,
    )
    return c.json({
      version,
      adapter: JSON.parse(adapter) as unknown,
    })
  })

  app.post('/works/:name/workflows', async (c) => {
    const body = await jsonObject(c.req)
    const workflow = attachWorkflow(
      runner.db,
      c.req.param('name'),
      stringField(body, 'workflowName'),
    )
    return c.json({ name: workflow.name })
  })
}

function linkJson(db: DatabaseSync, link: WorkLink) {
  const map = readAdapterMap(link.adapter_json)
  const rows = db
    .prepare(
      `SELECT r.version, r.message, r.created_at, r.api_json,
              r.id = current.head_revision_id AS head,
              r.id = main.head_revision_id AS main_head
       FROM workflow_revisions r
       JOIN workflow_branches current
         ON current.workflow_id = r.workflow_id AND current.name = (
           SELECT current_branch FROM workflows WHERE id = r.workflow_id
         )
       JOIN workflow_branches main
         ON main.workflow_id = r.workflow_id AND main.name = 'main'
       WHERE r.workflow_id = ?
       ORDER BY r.created_at`,
    )
    .all(link.id) as Array<{
    version: string
    message: string | null
    created_at: string
    api_json: string
    head: number
    main_head: number
  }>
  return {
    id: link.id,
    name: link.name,
    comfyPath: link.comfy_path,
    versions: rows.map((row) => {
      const prompt = JSON.parse(row.api_json) as Prompt
      const resolved = resolveAdapter(map, row.version, rows)
      const adapterJson = resolved.adapter
        ? JSON.stringify(resolved.adapter)
        : null
      return {
        version: row.version,
        message: row.message,
        createdAt: row.created_at,
        head: Boolean(row.head),
        main: Boolean(row.main_head),
        hasAdapter: map[row.version] !== undefined,
        borrowedFrom: resolved.borrowedFrom,
        adapter: resolved.adapter,
        adapterStatus: adapterFit(prompt, adapterJson),
        suggestedAdapter: resolved.adapter ? null : suggestAdapter(prompt),
      }
    }),
  }
}
