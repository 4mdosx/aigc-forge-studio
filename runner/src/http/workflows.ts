import type { Hono } from 'hono'

import {
  isVersionId,
  revisionById,
  workflowByName,
  type TaskRow,
  type WorkflowRow,
} from '../db.ts'
import { RunnerError } from '../errors.ts'
import type { DatabaseSync } from 'node:sqlite'

import type { Runner } from '../task/queue.ts'
import {
  checkout,
  commitHead,
  updateRevisionMessage,
  createBranch,
  moveBranch,
  readAndCreate,
  storedStatus,
  switchBranch,
  syncFromComfy,
} from '../workflow/revisions.ts'
import { editor, jsonObject, stringField, taskJson } from './request.ts'

export function mountWorkflows(app: Hono, runner: Runner): void {
  app.get('/comfy/workflows', async (c) => {
    const client = editor(runner)
    const paths = await client.workflows()
    const workflows = await Promise.all(
      paths.map(async (path) => ({
        path,
        name: libraryName(path),
        status: await storedStatus(runner.db, client, path),
      })),
    )
    return c.json({ workflows })
  })

  app.post('/comfy/workflows', async (c) => {
    const body = await jsonObject(c.req)
    const action = stringField(body, 'action')
    if (action !== 'import' && action !== 'update') {
      throw new RunnerError('action must be import or update')
    }
    const available = await editor(runner).workflows()
    const paths = pathList(body.paths, available)
    const created: SyncRow[] = []
    const updated: SyncRow[] = []
    const unchanged: SyncRow[] = []
    const failed: Array<{ path: string; error: string }> = []
    for (const path of paths) {
      try {
        const result = await syncFromComfy(
          runner.db,
          editor(runner),
          { name: libraryName(path), comfyPath: path, action },
          runner.now(),
        )
        const row = {
          path,
          name: result.workflow.name,
          id: result.workflow.id,
          version: result.revision.version,
        }
        if (result.status === 'created') created.push(row)
        else if (result.status === 'updated') updated.push(row)
        else unchanged.push(row)
      } catch (err) {
        failed.push({
          path,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return c.json({ created, updated, unchanged, failed })
  })

  app.get('/workflows', (c) => {
    const rows = runner.db
      .prepare('SELECT * FROM workflows ORDER BY name')
      .all() as unknown as WorkflowRow[]
    return c.json({
      workflows: rows.map((row) => workflowJson(runner.db, row)),
    })
  })

  app.post('/workflows', async (c) => {
    const body = await jsonObject(c.req)
    const created = await readAndCreate(
      runner.db,
      editor(runner),
      {
        name: stringField(body, 'name'),
        comfyPath: stringField(body, 'comfyPath'),
        ...(body.message === undefined
          ? {}
          : { message: stringField(body, 'message') }),
      },
      runner.now(),
    )
    return c.json(
      { id: created.workflow.id, revisionId: created.revision.id },
      201,
    )
  })

  app.post('/workflows/:name/switch', async (c) => {
    const body = await jsonObject(c.req)
    const workflow = switchBranch(
      runner.db,
      c.req.param('name'),
      stringField(body, 'branch'),
    )
    return c.json({
      name: workflow.name,
      currentBranch: workflow.current_branch,
    })
  })

  app.post('/workflows/:name/branches', async (c) => {
    const body = await jsonObject(c.req)
    const branch = createBranch(
      runner.db,
      c.req.param('name'),
      stringField(body, 'name'),
      body.revisionId === undefined
        ? undefined
        : stringField(body, 'revisionId'),
    )
    return c.json(
      { name: branch.name, headRevisionId: branch.head_revision_id },
      201,
    )
  })

  app.post('/workflows/:name/branches/:branch', async (c) => {
    const body = await jsonObject(c.req)
    const branch = moveBranch(
      runner.db,
      c.req.param('name'),
      c.req.param('branch'),
      stringField(body, 'revisionId'),
      stringField(body, 'expectedHead'),
    )
    return c.json({
      name: branch.name,
      headRevisionId: branch.head_revision_id,
    })
  })

  app.post('/workflows/:name/checkout', async (c) => {
    await checkout(runner.db, editor(runner), c.req.param('name'))
    return c.json({ ok: true })
  })

  app.post('/workflows/:name/revisions/:version/message', async (c) => {
    const body = await jsonObject(c.req)
    const version = versionOf(c.req.param('version'))
    const message = body.message
    if (message !== null && typeof message !== 'string') {
      throw new RunnerError('message must be a string')
    }
    const text = typeof message === 'string' ? message.trim() : ''
    updateRevisionMessage(
      runner.db,
      c.req.param('name'),
      version,
      text === '' ? null : text,
    )
    return c.json({ ok: true })
  })

  app.post('/workflows/:name/revisions/:version/checkout', async (c) => {
    const version = versionOf(c.req.param('version'))
    await checkout(runner.db, editor(runner), c.req.param('name'), version)
    return c.json({ ok: true })
  })

  app.post('/workflows/:name/commit', async (c) => {
    const body = await jsonObject(c.req)
    const revision = await commitHead(
      runner.db,
      editor(runner),
      c.req.param('name'),
      {
        ...(body.message === undefined
          ? {}
          : { message: stringField(body, 'message') }),
      },
      runner.now(),
    )
    return c.json({ id: revision.id, version: revision.version }, 201)
  })

  app.get('/workflows/:name/revisions', (c) => {
    const workflow = workflowByName(runner.db, c.req.param('name'))
    const rows = runner.db
      .prepare(
        `SELECT r.id, r.version, r.message, r.created_at,
                r.id = current.head_revision_id AS head,
                r.id = main.head_revision_id AS main_head
         FROM workflow_revisions r
         JOIN workflow_branches current
           ON current.workflow_id = r.workflow_id AND current.name = ?
         JOIN workflow_branches main
           ON main.workflow_id = r.workflow_id AND main.name = 'main'
         WHERE r.workflow_id = ?
         ORDER BY r.created_at`,
      )
      .all(workflow.current_branch, workflow.id) as unknown as RevisionListRow[]
    const parents = runner.db
      .prepare(
        `SELECT child.version AS version, parent.version AS parent_version
         FROM workflow_revision_parents link
         JOIN workflow_revisions child ON child.id = link.revision_id
         JOIN workflow_revisions parent ON parent.id = link.parent_id
         WHERE child.workflow_id = ?
         ORDER BY link.parent_order`,
      )
      .all(workflow.id) as Array<{ version: string; parent_version: string }>
    const parentsOf = new Map<string, string[]>()
    for (const link of parents) {
      const list = parentsOf.get(link.version) ?? []
      list.push(link.parent_version)
      parentsOf.set(link.version, list)
    }
    return c.json({
      revisions: rows.map((row) => ({
        id: row.id,
        version: row.version,
        message: row.message,
        createdAt: row.created_at,
        head: Boolean(row.head),
        main: Boolean(row.main_head),
        parents: parentsOf.get(row.version) ?? [],
      })),
    })
  })

  app.get('/workflows/:name/revisions/:version', (c) => {
    const workflow = workflowByName(runner.db, c.req.param('name'))
    const version = versionOf(c.req.param('version'))
    const row = runner.db
      .prepare(
        `SELECT version, message, ui_json FROM workflow_revisions
         WHERE workflow_id = ? AND version = ?`,
      )
      .get(workflow.id, version) as
      { version: string; message: string | null; ui_json: string } | undefined
    if (!row) throw new RunnerError(`version ${version} not found`, 404)
    const document = JSON.parse(row.ui_json) as unknown
    return c.json({
      version: row.version,
      message: row.message,
      workflow: document,
      ...graphView(document),
    })
  })

  app.get('/revisions/:id/tasks', (c) => {
    revisionById(runner.db, c.req.param('id'))
    const rows = runner.db
      .prepare(
        'SELECT * FROM tasks WHERE head_revision_id = ? ORDER BY created_at',
      )
      .all(c.req.param('id')) as unknown as TaskRow[]
    return c.json({ tasks: rows.map((row) => taskJson(runner.db, row)) })
  })
}

function versionOf(value: string): string {
  if (!isVersionId(value)) {
    throw new RunnerError('version must be an 8 character id')
  }
  return value
}

interface RevisionListRow {
  id: string
  version: string
  message: string | null
  created_at: string
  head: number
  main_head: number
}

function graphView(ui: unknown): {
  nodes: Array<{
    id: number
    type: string
    title: string
    x: number
    y: number
  }>
  links: Array<{ from: number; to: number }>
} {
  const record =
    ui && typeof ui === 'object' && !Array.isArray(ui)
      ? (ui as { nodes?: unknown; links?: unknown })
      : {}
  const nodes = Array.isArray(record.nodes)
    ? record.nodes.flatMap((node) => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) return []
        const item = node as {
          id?: unknown
          type?: unknown
          title?: unknown
          pos?: unknown
        }
        if (typeof item.id !== 'number' || typeof item.type !== 'string')
          return []
        const pos = Array.isArray(item.pos) ? item.pos : []
        return [
          {
            id: item.id,
            type: item.type,
            title: typeof item.title === 'string' ? item.title : '',
            x: typeof pos[0] === 'number' ? pos[0] : 0,
            y: typeof pos[1] === 'number' ? pos[1] : 0,
          },
        ]
      })
    : []
  const links = Array.isArray(record.links)
    ? record.links.flatMap((link) => {
        if (!Array.isArray(link) || link.length < 5) return []
        const from = link[1]
        const to = link[3]
        if (typeof from !== 'number' || typeof to !== 'number') return []
        return [{ from, to }]
      })
    : []
  return { nodes, links }
}

interface SyncRow {
  path: string
  name: string
  id: string
  version: string
}

function workflowJson(db: DatabaseSync, row: WorkflowRow) {
  const works = db
    .prepare(
      `SELECT DISTINCT works.name
       FROM work_workflows
       JOIN works ON works.id = work_workflows.work_id
       WHERE work_workflows.workflow_id = ?
       ORDER BY works.name`,
    )
    .all(row.id) as Array<{ name: string }>
  return {
    id: row.id,
    name: row.name,
    comfyPath: row.comfy_path,
    currentBranch: row.current_branch,
    works: works.map((work) => work.name),
  }
}

function libraryName(path: string): string {
  return path.replace(/\.json$/i, '')
}

function pathList(value: unknown, available: string[]): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RunnerError('paths must be a non-empty array')
  }
  const known = new Set(available)
  return value.map((item) => {
    if (typeof item !== 'string' || item === '') {
      throw new RunnerError('paths must contain workflow filenames')
    }
    if (!known.has(item))
      throw new RunnerError(`ComfyUI has no workflow ${item}`)
    return item
  })
}
