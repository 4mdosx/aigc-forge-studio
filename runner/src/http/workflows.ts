import type { Hono } from 'hono'

import {
  revisionById,
  workflowByName,
  type TaskRow,
  type WorkflowRow,
} from '../db.ts'
import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'
import {
  checkout,
  commitHead,
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
      workflows: rows.map((row) => ({
        id: row.id,
        name: row.name,
        comfyPath: row.comfy_path,
        currentBranch: row.current_branch,
      })),
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
        ...(body.adapter === undefined ? {} : { adapter: body.adapter }),
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
        ...(body.adapter === undefined ? {} : { adapter: body.adapter }),
      },
      runner.now(),
    )
    return c.json({ id: revision.id, version: revision.version }, 201)
  })

  app.get('/workflows/:name/revisions', (c) => {
    const workflow = workflowByName(runner.db, c.req.param('name'))
    const rows = runner.db
      .prepare(
        `SELECT id, version, message, created_at FROM workflow_revisions
         WHERE workflow_id = ? ORDER BY version`,
      )
      .all(workflow.id) as unknown as Array<{
      id: string
      version: number
      message: string | null
      created_at: string
    }>
    return c.json({
      revisions: rows.map((row) => ({
        id: row.id,
        version: row.version,
        message: row.message,
        createdAt: row.created_at,
      })),
    })
  })

  app.get('/revisions/:id/tasks', (c) => {
    revisionById(runner.db, c.req.param('id'))
    const rows = runner.db
      .prepare(
        'SELECT * FROM tasks WHERE head_revision_id = ? ORDER BY created_at',
      )
      .all(c.req.param('id')) as unknown as TaskRow[]
    return c.json({ tasks: rows.map(taskJson) })
  })
}

interface SyncRow {
  path: string
  name: string
  id: string
  version: number
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
