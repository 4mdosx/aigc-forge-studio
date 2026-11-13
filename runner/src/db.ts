import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { RunnerError } from './errors.ts'

const taskColumns = `
  id TEXT PRIMARY KEY,
  workflow_name TEXT NOT NULL,
  workflow_id TEXT,
  work_id TEXT,
  comfy_path TEXT,
  adapter_json TEXT,
  api_json TEXT,
  head_revision_id TEXT NOT NULL,
  parent_task_id TEXT,
  task TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt_id TEXT,
  comfy_base_url TEXT,
  error TEXT,
  output_path TEXT,
  process_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (head_revision_id) REFERENCES workflow_revisions(id),
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id)
`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  semantic_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  comfy_path TEXT NOT NULL,
  current_branch TEXT NOT NULL,
  work_id TEXT,
  adapter_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (work_id) REFERENCES works(id)
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
${taskColumns}
);

CREATE INDEX IF NOT EXISTS tasks_by_revision ON tasks (head_revision_id);
CREATE INDEX IF NOT EXISTS tasks_by_status ON tasks (status, created_at);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (role IN ('user', 'assistant')),
  FOREIGN KEY (chat_id) REFERENCES chats(id)
);

CREATE INDEX IF NOT EXISTS chat_messages_by_chat ON chat_messages (chat_id, created_at);
`

export interface WorkRow {
  id: string
  name: string
  semantic_json: string
  created_at: string
}

export interface WorkflowRow {
  id: string
  name: string
  comfy_path: string
  current_branch: string
  work_id: string | null
  adapter_json: string | null
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
  workflow_name: string | null
  workflow_id: string | null
  work_id: string | null
  comfy_path: string | null
  adapter_json: string | null
  api_json: string | null
  head_revision_id: string | null
  parent_task_id: string | null
  task: string
  input_json: string
  status: string
  prompt_id: string | null
  comfy_base_url: string | null
  error: string | null
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
  migrate(db)
  return db
}

function migrate(db: DatabaseSync): void {
  addColumn(db, 'workflows', 'work_id', 'TEXT')
  addColumn(db, 'workflows', 'adapter_json', 'TEXT')
  addColumn(db, 'tasks', 'workflow_id', 'TEXT')
  addColumn(db, 'tasks', 'work_id', 'TEXT')
  addColumn(db, 'tasks', 'comfy_path', 'TEXT')
  addColumn(db, 'tasks', 'adapter_json', 'TEXT')
  addColumn(db, 'tasks', 'api_json', 'TEXT')
  db.exec(
    `UPDATE workflows
     SET adapter_json = (
       SELECT adapter_json FROM workflow_revisions
       WHERE workflow_id = workflows.id AND adapter_json IS NOT NULL
       ORDER BY version DESC LIMIT 1
     )
     WHERE adapter_json IS NULL`,
  )
  dropLlmTasks(db)
}

function dropLlmTasks(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{
    name: string
  }>
  if (!columns.some((column) => column.name === 'executor')) return
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    transaction(db, () => {
      db.exec(`
        UPDATE tasks SET parent_task_id = NULL
        WHERE parent_task_id IN (SELECT id FROM tasks WHERE executor = 'llm');
        DELETE FROM tasks WHERE executor = 'llm';
        CREATE TABLE tasks_next (${taskColumns});
        INSERT INTO tasks_next (
          id, workflow_name, workflow_id, work_id, comfy_path, adapter_json, api_json,
          head_revision_id, parent_task_id, task, input_json, status, prompt_id,
          comfy_base_url, error, output_path, process_json, created_at, started_at, completed_at
        )
        SELECT
          id, workflow_name, workflow_id, work_id, comfy_path, adapter_json, api_json,
          head_revision_id, parent_task_id, task, input_json, status, prompt_id,
          comfy_base_url, error, output_path, process_json, created_at, started_at, completed_at
        FROM tasks;
        DROP TABLE tasks;
        ALTER TABLE tasks_next RENAME TO tasks;
        CREATE INDEX tasks_by_revision ON tasks (head_revision_id);
        CREATE INDEX tasks_by_status ON tasks (status, created_at);
      `)
    })
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

function addColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  type: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string
  }>
  if (rows.some((row) => row.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
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
