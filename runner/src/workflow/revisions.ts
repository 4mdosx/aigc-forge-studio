import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { workflowName, type ComfyClient } from '../comfy/client.ts'
import { promptFromUi } from '../comfy/prompt.ts'
import {
  branchOf,
  revisionById,
  transaction,
  workflowByName,
  type BranchRow,
  type RevisionRow,
  type WorkflowRow,
} from '../db.ts'
import { RunnerError } from '../errors.ts'
import { assertAdapter, parseAdapter } from './binding.ts'
import type { Prompt } from './graph.ts'

export type SyncStatus = 'created' | 'updated' | 'unchanged'

export async function readAndCreate(
  db: DatabaseSync,
  client: ComfyClient,
  input: {
    name: string
    comfyPath: string
    message?: string
    adapter?: unknown
  },
  now: Date,
): Promise<{ workflow: WorkflowRow; revision: RevisionRow }> {
  const path = workflowName(input.comfyPath)
  const loaded = await loadGraph(client, path)
  return insertFirst(db, requiredName(input.name), path, loaded, input, now)
}

export async function storedStatus(
  db: DatabaseSync,
  client: ComfyClient,
  comfyPath: string,
): Promise<'new' | 'updated' | 'unchanged'> {
  const path = workflowName(comfyPath)
  const workflow = workflowByPath(db, path)
  if (!workflow) return 'new'
  const head = headRevision(db, workflow)
  const loaded = await loadGraph(client, path)
  return sameDocument(head.ui_json, loaded.ui) ? 'unchanged' : 'updated'
}

export async function syncFromComfy(
  db: DatabaseSync,
  client: ComfyClient,
  input: { name: string; comfyPath: string; action: 'import' | 'update' },
  now: Date,
): Promise<{
  status: SyncStatus
  workflow: WorkflowRow
  revision: RevisionRow
}> {
  const path = workflowName(input.comfyPath)
  const loaded = await loadGraph(client, path)
  const workflow = workflowByPath(db, path)
  if (input.action === 'import') {
    if (!workflow) {
      const created = insertFirst(
        db,
        requiredName(input.name),
        path,
        loaded,
        {},
        now,
      )
      return { status: 'created', ...created }
    }
    const head = headRevision(db, workflow)
    if (sameDocument(head.ui_json, loaded.ui)) {
      return { status: 'unchanged', workflow, revision: head }
    }
    throw new RunnerError('文件已变化，请使用覆盖')
  }
  if (!workflow) throw new RunnerError('尚未入库')
  const head = headRevision(db, workflow)
  if (sameDocument(head.ui_json, loaded.ui)) {
    return { status: 'unchanged', workflow, revision: head }
  }
  const revision = overwriteHead(db, head, loaded)
  return { status: 'updated', workflow, revision }
}

export async function commitHead(
  db: DatabaseSync,
  client: ComfyClient,
  name: string,
  input: { message?: string },
  now: Date,
): Promise<RevisionRow> {
  const workflow = workflowByName(db, name)
  const loaded = await loadGraph(client, workflow.comfy_path)
  return appendRevision(db, workflow, loaded, input, now)
}

export async function checkout(
  db: DatabaseSync,
  client: ComfyClient,
  name: string,
): Promise<void> {
  const workflow = workflowByName(db, name)
  const branch = branchOf(db, workflow.id, workflow.current_branch)
  const revision = revisionById(db, branch.head_revision_id)
  await client.writeWorkflow(
    workflow.comfy_path,
    JSON.parse(revision.ui_json) as unknown,
  )
}

export function switchBranch(
  db: DatabaseSync,
  name: string,
  branchName: string,
): WorkflowRow {
  const workflow = workflowByName(db, name)
  branchOf(db, workflow.id, branchName)
  db.prepare('UPDATE workflows SET current_branch = ? WHERE id = ?').run(
    branchName,
    workflow.id,
  )
  return workflowByName(db, name)
}

export function createBranch(
  db: DatabaseSync,
  name: string,
  branchName: string,
  revisionId?: string,
): BranchRow {
  const workflow = workflowByName(db, name)
  const current = branchOf(db, workflow.id, workflow.current_branch)
  const revision = revisionById(db, revisionId ?? current.head_revision_id)
  if (revision.workflow_id !== workflow.id) {
    throw new RunnerError('revision is not in this workflow')
  }
  const label = requiredName(branchName)
  const exists = db
    .prepare(
      'SELECT name FROM workflow_branches WHERE workflow_id = ? AND name = ?',
    )
    .get(workflow.id, label)
  if (exists) throw new RunnerError(`branch ${label} already exists`)
  db.prepare(
    `INSERT INTO workflow_branches (workflow_id, name, head_revision_id)
     VALUES (?, ?, ?)`,
  ).run(workflow.id, label, revision.id)
  return branchOf(db, workflow.id, label)
}

export function moveBranch(
  db: DatabaseSync,
  name: string,
  branchName: string,
  revisionId: string,
  expectedHead: string,
): BranchRow {
  const workflow = workflowByName(db, name)
  const revision = revisionById(db, revisionId)
  if (revision.workflow_id !== workflow.id) {
    throw new RunnerError('revision is not in this workflow')
  }
  const moved = db
    .prepare(
      `UPDATE workflow_branches
       SET head_revision_id = ?
       WHERE workflow_id = ? AND name = ? AND head_revision_id = ?`,
    )
    .run(revision.id, workflow.id, branchName, expectedHead)
  if (moved.changes !== 1) throw new RunnerError('branch moved', 409)
  return branchOf(db, workflow.id, branchName)
}

async function loadGraph(
  client: ComfyClient,
  path: string,
): Promise<{ ui: unknown; api: Prompt }> {
  const ui = await client.workflow(path)
  return { ui, api: promptFromUi(ui, path) }
}

function workflowByPath(
  db: DatabaseSync,
  path: string,
): WorkflowRow | undefined {
  return db
    .prepare('SELECT * FROM workflows WHERE comfy_path = ?')
    .get(path) as WorkflowRow | undefined
}

function headRevision(db: DatabaseSync, workflow: WorkflowRow): RevisionRow {
  const branch = branchOf(db, workflow.id, workflow.current_branch)
  const head = revisionById(db, branch.head_revision_id)
  if (head.workflow_id !== workflow.id) {
    throw new RunnerError('branch head is not in this workflow')
  }
  return head
}

function insertFirst(
  db: DatabaseSync,
  name: string,
  path: string,
  loaded: { ui: unknown; api: Prompt },
  input: { message?: string; adapter?: unknown },
  now: Date,
): { workflow: WorkflowRow; revision: RevisionRow } {
  if (db.prepare('SELECT id FROM workflows WHERE name = ?').get(name)) {
    throw new RunnerError(`workflow ${name} already exists`)
  }
  const adapterJson =
    input.adapter === undefined
      ? null
      : JSON.stringify(checkedAdapter(loaded.api, input.adapter))
  const createdAt = now.toISOString()
  return transaction(db, () => {
    const workflowId = randomUUID()
    const revisionId = randomUUID()
    db.prepare(
      `INSERT INTO workflows
        (id, name, comfy_path, current_branch, work_id, adapter_json, created_at)
       VALUES (?, ?, ?, 'main', NULL, ?, ?)`,
    ).run(workflowId, name, path, adapterJson, createdAt)
    db.prepare(
      `INSERT INTO workflow_revisions
        (id, workflow_id, version, ui_json, api_json, adapter_json, message, created_at)
       VALUES (?, ?, 1, ?, ?, NULL, ?, ?)`,
    ).run(
      revisionId,
      workflowId,
      JSON.stringify(loaded.ui),
      JSON.stringify(loaded.api),
      input.message ?? null,
      createdAt,
    )
    db.prepare(
      `INSERT INTO workflow_branches (workflow_id, name, head_revision_id)
       VALUES (?, 'main', ?)`,
    ).run(workflowId, revisionId)
    return {
      workflow: workflowByName(db, name),
      revision: revisionById(db, revisionId),
    }
  })
}

function overwriteHead(
  db: DatabaseSync,
  head: RevisionRow,
  loaded: { ui: unknown; api: Prompt },
): RevisionRow {
  db.prepare(
    `UPDATE workflow_revisions SET ui_json = ?, api_json = ? WHERE id = ?`,
  ).run(JSON.stringify(loaded.ui), JSON.stringify(loaded.api), head.id)
  return revisionById(db, head.id)
}

function appendRevision(
  db: DatabaseSync,
  workflow: WorkflowRow,
  loaded: { ui: unknown; api: Prompt },
  input: { message?: string },
  now: Date,
): RevisionRow {
  return transaction(db, () => {
    const parent = headRevision(db, workflow)
    const branch = branchOf(db, workflow.id, workflow.current_branch)
    if (workflow.adapter_json) {
      assertAdapter(
        loaded.api,
        parseAdapter(JSON.parse(workflow.adapter_json) as unknown),
      )
    }
    const revisionId = randomUUID()
    const createdAt = now.toISOString()
    db.prepare(
      `INSERT INTO workflow_revisions
        (id, workflow_id, version, ui_json, api_json, adapter_json, message, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      revisionId,
      workflow.id,
      nextVersion(db, workflow.id),
      JSON.stringify(loaded.ui),
      JSON.stringify(loaded.api),
      input.message ?? null,
      createdAt,
    )
    db.prepare(
      `INSERT INTO workflow_revision_parents (revision_id, parent_id, parent_order)
       VALUES (?, ?, 0)`,
    ).run(revisionId, parent.id)
    const moved = db
      .prepare(
        `UPDATE workflow_branches
         SET head_revision_id = ?
         WHERE workflow_id = ? AND name = ? AND head_revision_id = ?`,
      )
      .run(revisionId, workflow.id, branch.name, parent.id)
    if (moved.changes !== 1) throw new RunnerError('branch moved', 409)
    return revisionById(db, revisionId)
  })
}

function sameDocument(stored: string, ui: unknown): boolean {
  return canonical(JSON.parse(stored) as unknown) === canonical(ui)
}

function canonical(value: unknown): string {
  return JSON.stringify(ordered(value))
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, ordered((value as Record<string, unknown>)[key])]),
  )
}

function checkedAdapter(api: Prompt, provided: unknown) {
  const adapter = parseAdapter(provided)
  assertAdapter(api, adapter)
  return adapter
}

function nextVersion(db: DatabaseSync, workflowId: string): number {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM workflow_revisions WHERE workflow_id = ?',
    )
    .get(workflowId) as { version: number }
  return row.version
}

function requiredName(name: string): string {
  if (typeof name !== 'string' || name.trim() === '')
    throw new RunnerError('name is required')
  return name.trim()
}
