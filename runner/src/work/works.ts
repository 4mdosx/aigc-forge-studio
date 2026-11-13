import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import {
  branchOf,
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
  const attached = workflowsOf(db, work.id)
  for (const workflow of attached) {
    if (!workflow.adapter_json) continue
    assertCovers(
      parseAdapter(JSON.parse(workflow.adapter_json) as unknown),
      parsed,
    )
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
  if (workflow.work_id !== work.id) {
    throw new RunnerError('workflow is not in this work')
  }
  db.prepare('UPDATE workflows SET work_id = NULL WHERE id = ?').run(
    workflow.id,
  )
  return workflowByName(db, workflow.name)
}

export function attachWorkflow(
  db: DatabaseSync,
  workName: string,
  workflowName: string,
): WorkflowRow {
  const work = workByName(db, workName)
  const workflow = workflowByName(db, workflowName)
  if (workflow.adapter_json) {
    assertCovers(
      parseAdapter(JSON.parse(workflow.adapter_json) as unknown),
      parseSemantic(JSON.parse(work.semantic_json) as unknown),
    )
  }
  db.prepare('UPDATE workflows SET work_id = ? WHERE id = ?').run(
    work.id,
    workflow.id,
  )
  return workflowByName(db, workflow.name)
}

export function saveAdapter(
  db: DatabaseSync,
  workflowName: string,
  raw: unknown,
): WorkflowRow {
  const workflow = workflowByName(db, workflowName)
  const adapter = parseAdapter(raw)
  const main = revisionById(
    db,
    branchOf(db, workflow.id, 'main').head_revision_id,
  )
  assertAdapter(JSON.parse(main.api_json) as Prompt, adapter)
  if (workflow.work_id) {
    const work = workById(db, workflow.work_id)
    assertCovers(
      adapter,
      parseSemantic(JSON.parse(work.semantic_json) as unknown),
    )
  }
  db.prepare('UPDATE workflows SET adapter_json = ? WHERE id = ?').run(
    JSON.stringify(adapter),
    workflow.id,
  )
  return workflowByName(db, workflow.name)
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

export function workflowsOf(db: DatabaseSync, workId: string): WorkflowRow[] {
  return db
    .prepare('SELECT * FROM workflows WHERE work_id = ? ORDER BY name')
    .all(workId) as unknown as WorkflowRow[]
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
