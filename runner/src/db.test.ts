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
