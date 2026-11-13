import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { assertAdapter, parseAdapter } from './binding.ts'
import type { ComfyClient } from './comfy.ts'
import {
  branchOf,
  revisionById,
  transaction,
  workflowByName,
  type BranchRow,
  type RevisionRow,
  type WorkflowRow,
} from './db.ts'
import { RunnerError } from './errors.ts'
import { promptFromUi } from './ui-workflow.ts'
import { workflowName } from './comfy.ts'
import type { Prompt } from './workflow.ts'

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
  const ui = await client.workflow(workflowName(input.comfyPath))
  const api = promptFromUi(ui, input.comfyPath)
  const adapterJson = adapterText(api, input.adapter, null)
  const createdAt = now.toISOString()
  const name = requiredName(input.name)
  if (db.prepare('SELECT id FROM workflows WHERE name = ?').get(name)) {
    throw new RunnerError(`workflow ${name} already exists`)
  }
  return transaction(db, () => {
    const workflowId = randomUUID()
    const revisionId = randomUUID()
    db.prepare(
      `INSERT INTO workflows (id, name, comfy_path, current_branch, created_at)
       VALUES (?, ?, ?, 'main', ?)`,
    ).run(workflowId, name, workflowName(input.comfyPath), createdAt)
    db.prepare(
      `INSERT INTO workflow_revisions
        (id, workflow_id, version, ui_json, api_json, adapter_json, message, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      revisionId,
      workflowId,
      JSON.stringify(ui),
      JSON.stringify(api),
      adapterJson,
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

export async function commitHead(
  db: DatabaseSync,
  client: ComfyClient,
  name: string,
  input: { message?: string; adapter?: unknown },
  now: Date,
): Promise<RevisionRow> {
  const workflow = workflowByName(db, name)
  const ui = await client.workflow(workflow.comfy_path)
  const api = promptFromUi(ui, workflow.comfy_path)
  return transaction(db, () => {
    const branch = branchOf(db, workflow.id, workflow.current_branch)
    const parent = revisionById(db, branch.head_revision_id)
    if (parent.workflow_id !== workflow.id) {
      throw new RunnerError('branch head is not in this workflow')
    }
    const adapterJson = adapterText(api, input.adapter, parent.adapter_json)
    const version = nextVersion(db, workflow.id)
    const revisionId = randomUUID()
    const createdAt = now.toISOString()
    db.prepare(
      `INSERT INTO workflow_revisions
        (id, workflow_id, version, ui_json, api_json, adapter_json, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      revisionId,
      workflow.id,
      version,
      JSON.stringify(ui),
      JSON.stringify(api),
      adapterJson,
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

function adapterText(
  api: Prompt,
  provided: unknown,
  parent: string | null,
): string | null {
  if (provided === undefined) {
    if (!parent) return null
    assertAdapter(api, parseAdapter(JSON.parse(parent) as unknown))
    return parent
  }
  const adapter = parseAdapter(provided)
  assertAdapter(api, adapter)
  return JSON.stringify(adapter)
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
