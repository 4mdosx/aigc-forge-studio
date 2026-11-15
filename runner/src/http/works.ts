import type { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID as uuid } from 'node:crypto'

import { RunnerError } from '../errors.ts'

import type { Runner } from '../task/queue.ts'
import { adapterFit, suggestAdapter } from '../workflow/binding.ts'
import { workflowByName } from '../db.ts'
import type { Prompt } from '../workflow/graph.ts'
import {
  attachWorkflow,
  createWork,
  deleteWork,
  detachWorkflow,
  linksOf,
  readAdapterMap,
  resolveAdapter,
  saveAdapter,
  saveWork,
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

  app.delete('/works/:name', (c) => {
    deleteWork(runner.db, c.req.param('name'))
    return c.json({ ok: true })
  })

  app.post('/works/:name/semantic', async (c) => {
    const body = await jsonObject(c.req)
    const current = c.req.param('name')
    const next = body.name === undefined ? current : stringField(body, 'name')
    const work = saveWork(runner.db, current, next, body.semantic)
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

  // 内部端点：从库内既有 revision 复制出新 workflow 并挂到 work 上。
  // 用途：ComfyUI userdata GET 被代理污染时（import/commit 链路全瘫），
  // 仍能以数据层方式复制 workflow。runner 进程自己写 DB 不经外部进程。
  app.post('/internal/import-workflow-copy', async (c) => {
    const body = await jsonObject(c.req)
    const name = stringField(body, 'name')
    const sourceWorkflow = workflowByName(
      runner.db,
      stringField(body, 'sourceWorkflow'),
    )
    const sourceVersion = stringField(body, 'sourceVersion')
    const work = workByName(runner.db, stringField(body, 'workName'))
    const source = runner.db
      .prepare(
        `SELECT id, ui_json, api_json FROM workflow_revisions
         WHERE workflow_id = ? AND version = ?`,
      )
      .get(sourceWorkflow.id, sourceVersion) as
      | { id: string; ui_json: string; api_json: string }
      | undefined
    if (!source)
      throw new RunnerError(
        `version ${sourceVersion} not found in ${sourceWorkflow.name}`,
      )
    // 版本号沿用 runner 字符集，全局查重
    const letters = 'abcdefghijklmnopqrstuvwxyz'
    const alphabet = letters + '0123456789'
    let version: string
    for (;;) {
      version = letters[Math.floor(Math.random() * letters.length)] ?? 'a'
      for (let i = 0; i < 7; i += 1) {
        version += alphabet[Math.floor(Math.random() * alphabet.length)]
      }
      const hit = runner.db
        .prepare('SELECT 1 FROM workflow_revisions WHERE version = ?')
        .get(version)
      if (!hit) break
    }
    const workflowId = uuid()
    const revisionId = uuid()
    const now = runner.now().toISOString()
    const message =
      body.message === undefined
        ? `copy of ${sourceWorkflow.name} ${sourceVersion}`
        : stringField(body, 'message')
    // adapter：复制源 workflow 绑定的 adapter map 并挂新版本键
    const sourceLink = linksOf(runner.db, work.id).find(
      (link) => link.name === sourceWorkflow.name,
    )
    const adapterMap = sourceLink
      ? JSON.parse(sourceLink.adapter_json)
      : {}
    const latestKey = Object.keys(adapterMap).at(-1)
    if (latestKey) adapterMap[version] = adapterMap[latestKey]
    const db = runner.db
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        `INSERT INTO workflows (id, name, comfy_path, current_branch, created_at)
         VALUES (?, ?, ?, 'main', ?)`,
      ).run(
        workflowId,
        name,
        body.comfyPath === undefined
          ? sourceWorkflow.comfy_path
          : stringField(body, 'comfyPath'),
        now,
      )
      db.prepare(
        `INSERT INTO workflow_revisions (id, workflow_id, version, ui_json, api_json, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(revisionId, workflowId, version, source.ui_json, source.api_json, message, now)
      db.prepare(
        `INSERT INTO workflow_branches (workflow_id, name, head_revision_id)
         VALUES (?, 'main', ?)`,
      ).run(workflowId, revisionId)
      db.prepare(
        `INSERT INTO work_workflows (work_id, workflow_id, adapter_json)
         VALUES (?, ?, ?)`,
      ).run(work.id, workflowId, JSON.stringify(adapterMap))
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return c.json({ id: workflowId, version, revisionId }, 201)
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
