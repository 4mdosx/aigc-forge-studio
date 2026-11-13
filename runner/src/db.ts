import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { RunnerError } from './errors.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  comfy_path TEXT NOT NULL,
  current_branch TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_revisions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  ui_json TEXT NOT NULL,
  api_json TEXT NOT NULL,
  adapter_json TEXT,
  message TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workflow_id, version),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);

CREATE TABLE IF NOT EXISTS workflow_revision_parents (
  revision_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  parent_order INTEGER NOT NULL,
  PRIMARY KEY (revision_id, parent_id),
  UNIQUE (revision_id, parent_order),
  FOREIGN KEY (revision_id) REFERENCES workflow_revisions(id),
  FOREIGN KEY (parent_id) REFERENCES workflow_revisions(id),
  CHECK (revision_id != parent_id),
  CHECK (parent_order >= 0)
);

CREATE TABLE IF NOT EXISTS workflow_branches (
  workflow_id TEXT NOT NULL,
  name TEXT NOT NULL,
  head_revision_id TEXT NOT NULL,
  PRIMARY KEY (workflow_id, name),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id),
  FOREIGN KEY (head_revision_id) REFERENCES workflow_revisions(id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  executor TEXT NOT NULL,
  workflow_name TEXT,
  head_revision_id TEXT,
  parent_task_id TEXT,
  task TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt_id TEXT,
  comfy_base_url TEXT,
  error TEXT,
  output_text TEXT,
  output_path TEXT,
  process_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  CHECK (executor IN ('comfyui', 'llm')),
  CHECK (
    (executor = 'comfyui' AND workflow_name IS NOT NULL AND head_revision_id IS NOT NULL)
    OR (executor = 'llm' AND workflow_name IS NULL AND head_revision_id IS NULL)
  ),
  FOREIGN KEY (head_revision_id) REFERENCES workflow_revisions(id),
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS tasks_by_revision ON tasks (head_revision_id);
CREATE INDEX IF NOT EXISTS tasks_by_executor_status ON tasks (executor, status, created_at);
`

export interface WorkflowRow {
  id: string
  name: string
  comfy_path: string
  current_branch: string
  created_at: string
}

export interface RevisionRow {
  id: string
  workflow_id: string
  version: number
  ui_json: string
  api_json: string
  adapter_json: string | null
  message: string | null
  created_at: string
}

export interface BranchRow {
  workflow_id: string
  name: string
  head_revision_id: string
}

export interface TaskRow {
  id: string
  executor: 'comfyui' | 'llm'
  workflow_name: string | null
  head_revision_id: string | null
  parent_task_id: string | null
  task: string
  input_json: string
  status: string
  prompt_id: string | null
  comfy_base_url: string | null
  error: string | null
  output_text: string | null
  output_path: string | null
  process_json: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}

export function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = run()
    db.exec('COMMIT')
    return value
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function workflowByName(db: DatabaseSync, name: string): WorkflowRow {
  const row = db.prepare('SELECT * FROM workflows WHERE name = ?').get(name) as
    WorkflowRow | undefined
  if (!row) throw new RunnerError(`workflow ${name} not found`, 404)
  return row
}

export function revisionById(db: DatabaseSync, id: string): RevisionRow {
  const row = db
    .prepare('SELECT * FROM workflow_revisions WHERE id = ?')
    .get(id) as RevisionRow | undefined
  if (!row) throw new RunnerError(`revision ${id} not found`, 404)
  return row
}

export function branchOf(
  db: DatabaseSync,
  workflowId: string,
  name: string,
): BranchRow {
  const row = db
    .prepare(
      'SELECT * FROM workflow_branches WHERE workflow_id = ? AND name = ?',
    )
    .get(workflowId, name) as BranchRow | undefined
  if (!row) throw new RunnerError(`branch ${name} not found`, 404)
  return row
}

export function taskById(db: DatabaseSync, id: string): TaskRow {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
    TaskRow | undefined
  if (!row) throw new RunnerError(`task ${id} not found`, 404)
  return row
}
