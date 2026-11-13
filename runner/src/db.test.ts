import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { openDatabase } from './db.ts'

test('removes llm tasks and the executor column from an existing database', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'aigc-db-')), 'runner.sqlite')
  const setup = new DatabaseSync(path)
  setup.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      executor TEXT NOT NULL,
      workflow_name TEXT,
      workflow_id TEXT,
      work_id TEXT,
      comfy_path TEXT,
      adapter_json TEXT,
      api_json TEXT,
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
      completed_at TEXT
    );
    INSERT INTO tasks
      (id, executor, task, input_json, status, output_text, created_at)
    VALUES
      ('llm-1', 'llm', 'prompt', '{}', 'completed', 'a knight', '2026-01-01T00:00:00.000Z');
    INSERT INTO tasks
      (id, executor, workflow_name, head_revision_id, parent_task_id, task, input_json,
       status, output_text, output_path, created_at)
    VALUES
      ('comfy-1', 'comfyui', 'picture', 'rev-1', 'llm-1', 'text2img', '{}',
       'completed', 'leak', 'output/a.png', '2026-01-01T00:00:01.000Z');
    INSERT INTO tasks
      (id, executor, workflow_name, head_revision_id, parent_task_id, task, input_json,
       status, created_at)
    VALUES
      ('comfy-2', 'comfyui', 'picture', 'rev-1', 'comfy-1', 'text2img', '{}',
       'pending', '2026-01-01T00:00:02.000Z');
  `)
  setup.close()

  const db = openDatabase(path)
  const names = (
    db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
  ).map((column) => column.name)
  assert.equal(names.includes('executor'), false)
  assert.equal(names.includes('output_text'), false)
  const rows = db
    .prepare(
      'SELECT id, parent_task_id, output_path FROM tasks ORDER BY created_at',
    )
    .all() as Array<{
    id: string
    parent_task_id: string | null
    output_path: string | null
  }>
  assert.deepEqual(
    rows.map((row) => ({
      id: row.id,
      parent_task_id: row.parent_task_id,
      output_path: row.output_path,
    })),
    [
      { id: 'comfy-1', parent_task_id: null, output_path: 'output/a.png' },
      { id: 'comfy-2', parent_task_id: 'comfy-1', output_path: null },
    ],
  )
  db.close()
})

test('moves workflow adapters onto work, workflow, and version', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'aigc-db-')), 'runner.sqlite')
  const setup = new DatabaseSync(path)
  setup.exec(`
    CREATE TABLE works (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      semantic_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      comfy_path TEXT NOT NULL,
      current_branch TEXT NOT NULL,
      work_id TEXT,
      adapter_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE workflow_revisions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      ui_json TEXT NOT NULL,
      api_json TEXT NOT NULL,
      adapter_json TEXT,
      message TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (workflow_id, version)
    );
    INSERT INTO works (id, name, semantic_json, created_at)
    VALUES ('work-1', 'picture', '{"inputs":{"text":{"type":"string"}}}', '2026-01-01T00:00:00.000Z');
    INSERT INTO workflows
      (id, name, comfy_path, current_branch, work_id, adapter_json, created_at)
    VALUES
      ('wf-1', 'picture-flow', 'picture-flow.json', 'main', 'work-1', '{"inputs":{}}', '2026-01-01T00:00:00.000Z');
    INSERT INTO workflow_revisions
      (id, workflow_id, version, ui_json, api_json, adapter_json, message, created_at)
    VALUES
      ('rev-1', 'wf-1', 1, '{}', '{}', '{"inputs":{"old":{}}}', NULL, '2026-01-01T00:00:00.000Z');
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      head_revision_id TEXT NOT NULL,
      task TEXT NOT NULL,
      input_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO tasks
      (id, workflow_name, head_revision_id, task, input_json, status, created_at)
    VALUES
      ('task-1', 'picture-flow', 'rev-1', 'text2img', '{}', 'completed', '2026-01-01T00:00:00.000Z');
  `)
  setup.close()

  const db = openDatabase(path)
  const workflowColumns = (
    db.prepare('PRAGMA table_info(workflows)').all() as Array<{ name: string }>
  ).map((column) => column.name)
  assert.equal(workflowColumns.includes('work_id'), false)
  assert.equal(workflowColumns.includes('adapter_json'), false)
  const revisionColumns = (
    db.prepare('PRAGMA table_info(workflow_revisions)').all() as Array<{
      name: string
    }>
  ).map((column) => column.name)
  assert.equal(revisionColumns.includes('adapter_json'), false)
  const revision = db
    .prepare('SELECT version FROM workflow_revisions WHERE id = ?')
    .get('rev-1') as { version: string }
  assert.match(revision.version, /^[0-9a-z]{8}$/)
  const binding = db
    .prepare('SELECT work_id, workflow_id, adapter_json FROM work_workflows')
    .get() as {
    work_id: string
    workflow_id: string
    adapter_json: string
  }
  assert.equal(binding.work_id, 'work-1')
  assert.equal(binding.workflow_id, 'wf-1')
  assert.deepEqual(JSON.parse(binding.adapter_json) as unknown, {
    [revision.version]: { inputs: {} },
  })
  const task = db
    .prepare('SELECT adapter_json FROM tasks WHERE id = ?')
    .get('task-1') as { adapter_json: string }
  assert.equal(task.adapter_json, '{"inputs":{}}')
  db.close()
})
