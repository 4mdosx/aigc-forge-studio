import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import {
  revisionById,
  workflowByName,
  type WorkRow,
  type WorkflowRow,
} from '../db.ts'
import { RunnerError } from '../errors.ts'
import {
  assertAdapter,
  parseAdapter,
  type AdapterMap,
} from '../workflow/binding.ts'
import type { Prompt } from '../workflow/graph.ts'

export interface SemanticField {
  type: 'string' | 'seed' | 'image'
}

export interface Semantic {
  inputs: Record<string, SemanticField>
}

export function createWork(
  db: DatabaseSync,
  name: string,
  semantic: unknown,
  now: Date,
): WorkRow {
  const label = requiredName(name)
  if (db.prepare('SELECT id FROM works WHERE name = ?').get(label)) {
    throw new RunnerError(`work ${label} already exists`)
  }
  const parsed = parseSemantic(semantic)
  const id = randomUUID()
  db.prepare(
    `INSERT INTO works (id, name, semantic_json, created_at) VALUES (?, ?, ?, ?)`,
  ).run(id, label, JSON.stringify(parsed), now.toISOString())
  return workByName(db, label)
}

export function updateSemantic(
  db: DatabaseSync,
  name: string,
  semantic: unknown,
): WorkRow {
  const work = workByName(db, name)
  const parsed = parseSemantic(semantic)
  for (const link of linksOf(db, work.id)) {
    for (const adapter of Object.values(readAdapterMap(link.adapter_json))) {
      assertCovers(adapter, parsed)
    }
  }
  db.prepare('UPDATE works SET semantic_json = ? WHERE id = ?').run(
    JSON.stringify(parsed),
    work.id,
  )
  return workByName(db, work.name)
}

export function detachWorkflow(
  db: DatabaseSync,
  workName: string,
  workflowName: string,
): WorkflowRow {
  const work = workByName(db, workName)
  const workflow = workflowByName(db, workflowName)
  const removed = db
    .prepare('DELETE FROM work_workflows WHERE work_id = ? AND workflow_id = ?')
    .run(work.id, workflow.id)
  if (removed.changes !== 1) {
    throw new RunnerError('workflow is not in this work', 404)
  }
  return workflow
}

export function attachWorkflow(
  db: DatabaseSync,
  workName: string,
  workflowName: string,
): WorkflowRow {
  const work = workByName(db, workName)
  const workflow = workflowByName(db, workflowName)
  if (linkOf(db, work.id, workflow.id)) {
    throw new RunnerError('workflow is already in this work')
  }
  db.prepare(
    `INSERT INTO work_workflows (work_id, workflow_id, adapter_json)
     VALUES (?, ?, '{}')`,
  ).run(work.id, workflow.id)
  return workflow
}

export function saveAdapter(
  db: DatabaseSync,
  workName: string,
  workflowName: string,
  version: string,
  raw: unknown,
): string {
  const work = workByName(db, workName)
  const workflow = workflowByName(db, workflowName)
  const link = linkOf(db, work.id, workflow.id)
  if (!link) throw new RunnerError('workflow is not in this work', 404)
  const adapter = parseAdapter(raw)
  const revision = revisionForBinding(db, workflow.id, version)
  assertAdapter(JSON.parse(revision.api_json) as Prompt, adapter)
  assertCovers(
    adapter,
    parseSemantic(JSON.parse(work.semantic_json) as unknown),
  )
  const map = readAdapterMap(link.adapter_json)
  map[revision.version] = adapter
  db.prepare(
    `UPDATE work_workflows SET adapter_json = ?
     WHERE work_id = ? AND workflow_id = ?`,
  ).run(JSON.stringify(map), work.id, workflow.id)
  return JSON.stringify(adapter)
}

export function workByName(db: DatabaseSync, name: string): WorkRow {
  const row = db.prepare('SELECT * FROM works WHERE name = ?').get(name) as
    WorkRow | undefined
  if (!row) throw new RunnerError(`work ${name} not found`, 404)
  return row
}

export function workById(db: DatabaseSync, id: string): WorkRow {
  const row = db.prepare('SELECT * FROM works WHERE id = ?').get(id) as
    WorkRow | undefined
  if (!row) throw new RunnerError('work not found', 404)
  return row
}

export interface WorkLink {
  id: string
  name: string
  comfy_path: string
  adapter_json: string
}

export function linksOf(db: DatabaseSync, workId: string): WorkLink[] {
  return db
    .prepare(
      `SELECT w.id, w.name, w.comfy_path, b.adapter_json
       FROM work_workflows b
       JOIN workflows w ON w.id = b.workflow_id
       WHERE b.work_id = ?
       ORDER BY w.name`,
    )
    .all(workId) as unknown as WorkLink[]
}

export function linkOf(
  db: DatabaseSync,
  workId: string,
  workflowId: string,
): { adapter_json: string } | undefined {
  return db
    .prepare(
      `SELECT adapter_json FROM work_workflows
       WHERE work_id = ? AND workflow_id = ?`,
    )
    .get(workId, workflowId) as { adapter_json: string } | undefined
}

export function readAdapterMap(raw: string | null): Record<string, AdapterMap> {
  if (!raw) return {}
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RunnerError('adapter map must be an object')
  }
  const map: Record<string, AdapterMap> = {}
  for (const [version, value] of Object.entries(parsed)) {
    map[version] = parseAdapter(value)
  }
  return map
}

export function resolveAdapter(
  map: Record<string, AdapterMap>,
  version: string,
  revisions: Array<{ version: string; created_at: string }>,
): { adapter: AdapterMap | null; borrowedFrom: string | null } {
  const own = map[version]
  if (own) return { adapter: own, borrowedFrom: null }
  const recent = revisions
    .filter((row) => map[row.version])
    .sort((left, right) => right.created_at.localeCompare(left.created_at))[0]
  const adapter = recent ? map[recent.version] : undefined
  if (!recent || !adapter) return { adapter: null, borrowedFrom: null }
  return { adapter, borrowedFrom: recent.version }
}

function revisionForBinding(
  db: DatabaseSync,
  workflowId: string,
  version: string,
) {
  const row = db
    .prepare(
      'SELECT * FROM workflow_revisions WHERE workflow_id = ? AND version = ?',
    )
    .get(workflowId, version)
  if (!row) throw new RunnerError(`version ${version} not found`, 404)
  return revisionById(db, (row as { id: string }).id)
}

export function parseSemantic(raw: unknown): Semantic {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RunnerError('semantic must be an object')
  }
  const inputs = (raw as { inputs?: unknown }).inputs
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new RunnerError('semantic inputs must be an object')
  }
  const parsed: Record<string, SemanticField> = {}
  for (const [key, value] of Object.entries(inputs)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new RunnerError(`semantic ${key} must be an object`)
    }
    const type = (value as { type?: unknown }).type
    if (type !== 'string' && type !== 'seed' && type !== 'image') {
      throw new RunnerError(
        `semantic ${key} type must be string, seed, or image`,
      )
    }
    parsed[key] = { type }
  }
  if (Object.keys(parsed).length === 0) {
    throw new RunnerError('semantic inputs are required')
  }
  return { inputs: parsed }
}

function assertCovers(adapter: AdapterMap, semantic: Semantic): void {
  const wanted = Object.keys(semantic.inputs).sort()
  const got = Object.keys(adapter.inputs).sort()
  if (wanted.join('\0') !== got.join('\0')) {
    throw new RunnerError('adapter inputs must match the work fields')
  }
  for (const [key, field] of Object.entries(semantic.inputs)) {
    const binding = adapter.inputs[key]
    if (!binding) throw new RunnerError(`adapter is missing ${key}`)
    if (field.type === 'seed' && binding.input !== 'seed') {
      throw new RunnerError(`${key} must map to seed`)
    }
    if (field.type === 'image' && binding.upload !== true) {
      throw new RunnerError(`${key} must upload a file`)
    }
  }
}

function requiredName(name: string): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new RunnerError('name is required')
  }
  return name.trim()
}
