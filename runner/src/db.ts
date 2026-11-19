import { randomInt } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { RunnerError } from './errors.ts'
import { seedRollConfig } from './rollConfig.ts'

const VERSION_LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const VERSION_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

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
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_revisions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  version TEXT NOT NULL,
  ui_json TEXT NOT NULL,
  api_json TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workflow_id, version),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);

CREATE TABLE IF NOT EXISTS work_workflows (
  work_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  adapter_json TEXT NOT NULL,
  PRIMARY KEY (work_id, workflow_id),
  FOREIGN KEY (work_id) REFERENCES works(id),
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
  chat_type TEXT,
  system_text TEXT,
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

CREATE TABLE IF NOT EXISTS dice_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  tiers TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dice_rolls (
  id TEXT PRIMARY KEY,
  pose_name TEXT,
  pose_id TEXT,
  fields_json TEXT NOT NULL DEFAULT '{}',
  prompt TEXT NOT NULL DEFAULT '',
  negative TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS dice_rolls_by_time ON dice_rolls (created_at);

CREATE TABLE IF NOT EXISTS dice_roll_tasks (
  id TEXT PRIMARY KEY,
  roll_id TEXT NOT NULL,
  task_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (roll_id) REFERENCES dice_rolls(id)
);

CREATE INDEX IF NOT EXISTS dice_roll_tasks_by_roll ON dice_roll_tasks (roll_id, created_at);

CREATE TABLE IF NOT EXISTS dice_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  character_slug TEXT,
  pose_name TEXT,
  pose_id TEXT,
  fields_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS dice_templates_by_name ON dice_templates (name);

CREATE TABLE IF NOT EXISTS image_assets (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  img_url TEXT NOT NULL DEFAULT '',
  parent_image_id TEXT,
  original_path TEXT NOT NULL,
  original_width INTEGER NOT NULL,
  original_height INTEGER NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  processed_path TEXT,
  processed_width INTEGER,
  processed_height INTEGER,
  thumb_path TEXT,
  nobg_path TEXT,
  nobg_width INTEGER,
  nobg_height INTEGER,
  tags_json TEXT NOT NULL DEFAULT '[]',
  embedding_json TEXT NOT NULL DEFAULT '[]',
  tags_model_version TEXT NOT NULL DEFAULT '',
  embedding_model_version TEXT NOT NULL DEFAULT '',
  rating TEXT NOT NULL DEFAULT '',
  reviewed_at INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS image_assets_by_status ON image_assets (status, created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  status TEXT NOT NULL,
  step TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_run_at INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE (kind, asset_id),
  CHECK (status IN ('pending', 'running', 'failed', 'done')),
  CHECK (step IN ('prepare', 'tag', 'embed'))
);

CREATE INDEX IF NOT EXISTS jobs_by_ready ON jobs (status, next_run_at, created_at);
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dataset_assets (
  dataset_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (dataset_id, asset_id),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES image_assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS dataset_assets_by_asset ON dataset_assets (asset_id);
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
  created_at: string
}

export interface RevisionRow {
  id: string
  workflow_id: string
  version: string
  ui_json: string
  api_json: string
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
  addColumn(db, 'tasks', 'workflow_id', 'TEXT')
  addColumn(db, 'tasks', 'work_id', 'TEXT')
  addColumn(db, 'tasks', 'comfy_path', 'TEXT')
  addColumn(db, 'tasks', 'adapter_json', 'TEXT')
  addColumn(db, 'tasks', 'api_json', 'TEXT')
  rewriteVersions(db)
  moveAdapters(db)
  backfillTaskAdapters(db)
  collapseWorkWorkflows(db)
  backfillTaskAdapters(db)
  rebuildWorkflows(db)
  rebuildRevisions(db)
  dropLlmTasks(db)
  addColumn(db, 'chats', 'chat_type', 'TEXT')
  addColumn(db, 'chats', 'system_text', 'TEXT')
  rebuildDiceFields(db)
  seedDiceFields(db)
  addColumn(db, 'image_assets', 'rating', "TEXT NOT NULL DEFAULT ''")
  addColumn(db, 'image_assets', 'thumb_path', 'TEXT')
  addColumn(db, 'image_assets', 'nobg_path', 'TEXT')
  addColumn(db, 'image_assets', 'nobg_width', 'INTEGER')
  addColumn(db, 'image_assets', 'nobg_height', 'INTEGER')
  seedRollConfig(db)
}

// dice_fields 曾用保留字 values 作列名，后升 candidates；v3 = tiers JSON 列。
// v2（candidates/count）→ v3：旧候选词整体转为 common 层，数据不丢。
function rebuildDiceFields(db: DatabaseSync): void {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dice_fields'",
    )
    .all()
  if (tables.length === 0) return
  const columns = (
    db.prepare('PRAGMA table_info(dice_fields)').all() as Array<{
      name: string
    }>
  ).map((c) => c.name)
  if (columns.includes('tiers')) return
  const rows = columns.includes('candidates')
    ? (db
        .prepare(
          'SELECT name, candidates, count, position FROM dice_fields ORDER BY position, id',
        )
        .all() as Array<{
        name: string
        candidates: string
        count: number
        position: number
      }>)
    : []
  db.exec('DROP TABLE dice_fields')
  db.exec(`CREATE TABLE dice_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    tiers TEXT NOT NULL DEFAULT '{}',
    position INTEGER NOT NULL DEFAULT 0
  )`)
  const insert = db.prepare(
    'INSERT INTO dice_fields (name, tiers, position) VALUES (?, ?, ?)',
  )
  for (const row of rows) {
    insert.run(
      row.name,
      JSON.stringify({ common: { values: row.candidates, count: row.count } }),
      row.position,
    )
  }
}

// dice 掷骰工作台：空表时填入 creative-intent patch 字段默认集（与 web 侧骨架一致）
function seedDiceFields(db: DatabaseSync): void {
  const row = db.prepare('SELECT COUNT(*) AS n FROM dice_fields').get() as {
    n: number
  }
  if (row.n > 0) return
  const insert = db.prepare(
    'INSERT INTO dice_fields (name, tiers, position) VALUES (?, ?, ?)',
  )
  for (const [index, field] of DEFAULT_DICE_FIELDS.entries()) {
    insert.run(
      field.name,
      JSON.stringify({ common: { values: field.values, count: field.count } }),
      index,
    )
  }
}

export const DEFAULT_DICE_FIELDS: Array<{
  name: string
  values: string
  count: number
}> = [
  {
    name: 'subject.type',
    values: '1girl, solo, 1boy, 2girls, janedoe',
    count: 1,
  },
  {
    name: 'subject.description',
    values:
      'silver hair, long hair, twintails, blue eyes, red eyes, blonde hair, black hair, green eyes, ponytail, short hair, purple eyes, hair ornament, tall female, petite',
    count: 3,
  },
  {
    name: 'outfit.clothing',
    values:
      'black gothic dress, white dress, kimono, school uniform, sailor uniform, jacket, hoodie, qipao, maid dress, combat suit, sweater, bikini armor, lab coat, cape',
    count: 2,
  },
  {
    name: 'outfit.accessories',
    values:
      'earrings, necklace, hair ribbon, choker, glasses, bracelet, thigh strap, gloves, hat, beret, headphones, cyberpunk visor',
    count: 2,
  },
  {
    name: 'pose.action',
    values:
      'standing, arms behind back, hands in pockets, sitting, crossed legs, leaning forward, looking back, walking, running, crouching, arms crossed, holding weapon',
    count: 2,
  },
  {
    name: 'pose.expression',
    values:
      'smile, closed mouth, melancholy, smirk, serious, blush, open mouth, expressionless, angry, surprised, gentle smile, grin',
    count: 1,
  },
  {
    name: 'composition.shot',
    values:
      'full body, upper body, cowboy shot, portrait, bust, wide shot, close-up',
    count: 1,
  },
  {
    name: 'composition.view',
    values:
      'from side, from above, from below, from behind, dynamic angle, dutch angle, front view',
    count: 1,
  },
  {
    name: 'composition.framing',
    values:
      'cowboy shot, portrait, centered framing, rule of thirds, symmetric framing',
    count: 1,
  },
  {
    name: 'environment.background',
    values:
      'simple background, white background, cityscape, night city, classroom, forest, beach, ruined city, laboratory, neon lights, underwater, cyberspace, gray background',
    count: 1,
  },
  {
    name: 'lighting.type',
    values:
      'soft lighting, backlighting, moonlight, rim lighting, dramatic shadow, sunset glow, neon lighting, dim light, spotlight, dappled sunlight',
    count: 1,
  },
  {
    name: 'style.rendering',
    values:
      'masterpiece, best quality, very aesthetic, absurdres, highres, detailed background',
    count: 3,
  },
  {
    name: 'constraints.exclude',
    values:
      'bad hands, extra fingers, watermark, signature, worst quality, low quality, jpeg artifacts, blurry, extra limbs, bad anatomy, text, logo',
    count: 6,
  },
]

function rewriteVersions(db: DatabaseSync): void {
  const rows = db
    .prepare('SELECT id, workflow_id, version FROM workflow_revisions')
    .all() as Array<{
    id: string
    workflow_id: string
    version: string | number
  }>
  const stale = rows.filter((row) => !isVersionId(String(row.version)))
  if (stale.length === 0) return
  const bindings = columnNames(db, 'work_workflows').includes('version')
  withoutForeignKeys(db, () => {
    transaction(db, () => {
      for (const row of stale) {
        const next = allocateVersion(db, row.workflow_id)
        if (bindings) {
          db.prepare(
            `UPDATE work_workflows SET version = ?
             WHERE workflow_id = ? AND version = ?`,
          ).run(next, row.workflow_id, String(row.version))
        }
        db.prepare(
          'UPDATE workflow_revisions SET version = ? WHERE id = ?',
        ).run(next, row.id)
      }
    })
  })
}

function moveAdapters(db: DatabaseSync): void {
  const workflowColumns = columnNames(db, 'workflows')
  if (!workflowColumns.includes('work_id')) return
  const revisionHasAdapter = columnNames(db, 'workflow_revisions').includes(
    'adapter_json',
  )
  const workflowHasAdapter = workflowColumns.includes('adapter_json')
  const perVersion = columnNames(db, 'work_workflows').includes('version')
  const workflows = db
    .prepare(
      `SELECT id, work_id, ${workflowHasAdapter ? 'adapter_json' : 'NULL AS adapter_json'}
       FROM workflows WHERE work_id IS NOT NULL`,
    )
    .all() as Array<{
    id: string
    work_id: string
    adapter_json: string | null
  }>
  for (const workflow of workflows) {
    const revisions = db
      .prepare(
        `SELECT version, ${revisionHasAdapter ? 'adapter_json' : 'NULL AS adapter_json'}
         FROM workflow_revisions WHERE workflow_id = ?`,
      )
      .all(workflow.id) as Array<{
      version: string | number
      adapter_json: string | null
    }>
    if (perVersion) {
      const insert = db.prepare(
        `INSERT OR IGNORE INTO work_workflows
           (work_id, workflow_id, version, adapter_json)
         VALUES (?, ?, ?, ?)`,
      )
      for (const revision of revisions) {
        insert.run(
          workflow.work_id,
          workflow.id,
          String(revision.version),
          workflow.adapter_json ?? revision.adapter_json,
        )
      }
      continue
    }
    const map: Record<string, unknown> = {}
    for (const revision of revisions) {
      const adapter = workflow.adapter_json ?? revision.adapter_json
      if (!adapter) continue
      map[String(revision.version)] = JSON.parse(adapter) as unknown
    }
    db.prepare(
      `INSERT OR IGNORE INTO work_workflows (work_id, workflow_id, adapter_json)
       VALUES (?, ?, ?)`,
    ).run(workflow.work_id, workflow.id, JSON.stringify(map))
  }
}

function backfillTaskAdapters(db: DatabaseSync): void {
  if (!columnNames(db, 'tasks').includes('adapter_json')) return
  if (!columnNames(db, 'work_workflows').includes('adapter_json')) return
  if (columnNames(db, 'work_workflows').includes('version')) {
    db.exec(
      `UPDATE tasks
       SET adapter_json = (
         SELECT b.adapter_json
         FROM work_workflows b
         JOIN workflow_revisions r
           ON r.workflow_id = b.workflow_id AND r.version = b.version
         WHERE r.id = tasks.head_revision_id
           AND b.adapter_json IS NOT NULL
           AND (tasks.work_id IS NULL OR b.work_id = tasks.work_id)
       )
       WHERE adapter_json IS NULL
         AND (
           SELECT COUNT(*)
           FROM work_workflows b
           JOIN workflow_revisions r
             ON r.workflow_id = b.workflow_id AND r.version = b.version
           WHERE r.id = tasks.head_revision_id
             AND b.adapter_json IS NOT NULL
             AND (tasks.work_id IS NULL OR b.work_id = tasks.work_id)
         ) = 1`,
    )
    return
  }
  const tasks = db
    .prepare(
      `SELECT id, work_id, head_revision_id FROM tasks
       WHERE adapter_json IS NULL AND head_revision_id IS NOT NULL`,
    )
    .all() as Array<{
    id: string
    work_id: string | null
    head_revision_id: string
  }>
  const update = db.prepare(
    'UPDATE tasks SET adapter_json = ? WHERE id = ? AND adapter_json IS NULL',
  )
  for (const task of tasks) {
    const revision = db
      .prepare(
        'SELECT workflow_id, version FROM workflow_revisions WHERE id = ?',
      )
      .get(task.head_revision_id) as
      { workflow_id: string; version: string } | undefined
    if (!revision) continue
    const links = db
      .prepare(
        'SELECT work_id, adapter_json FROM work_workflows WHERE workflow_id = ?',
      )
      .all(revision.workflow_id) as Array<{
      work_id: string
      adapter_json: string
    }>
    const matches = links.filter(
      (link) => task.work_id === null || link.work_id === task.work_id,
    )
    if (matches.length !== 1) continue
    const map = adapterObject(matches[0]?.adapter_json)
    const own = map[String(revision.version)]
    if (own === undefined) continue
    update.run(JSON.stringify(own), task.id)
  }
}

function collapseWorkWorkflows(db: DatabaseSync): void {
  if (!columnNames(db, 'work_workflows').includes('version')) return
  const rows = db
    .prepare(
      'SELECT work_id, workflow_id, version, adapter_json FROM work_workflows',
    )
    .all() as Array<{
    work_id: string
    workflow_id: string
    version: string
    adapter_json: string | null
  }>
  const grouped = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const key = `${row.work_id}\0${row.workflow_id}`
    const map = grouped.get(key) ?? {}
    if (row.adapter_json) {
      map[String(row.version)] = JSON.parse(row.adapter_json) as unknown
    }
    grouped.set(key, map)
  }
  withoutForeignKeys(db, () => {
    transaction(db, () => {
      db.exec(`
        CREATE TABLE work_workflows_next (
          work_id TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          adapter_json TEXT NOT NULL,
          PRIMARY KEY (work_id, workflow_id),
          FOREIGN KEY (work_id) REFERENCES works(id),
          FOREIGN KEY (workflow_id) REFERENCES workflows(id)
        );
      `)
      const insert = db.prepare(
        `INSERT INTO work_workflows_next (work_id, workflow_id, adapter_json)
         VALUES (?, ?, ?)`,
      )
      for (const [key, map] of grouped) {
        const split = key.indexOf('\0')
        insert.run(
          key.slice(0, split),
          key.slice(split + 1),
          JSON.stringify(map),
        )
      }
      db.exec(`
        DROP TABLE work_workflows;
        ALTER TABLE work_workflows_next RENAME TO work_workflows;
      `)
    })
  })
}

function adapterObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

function rebuildWorkflows(db: DatabaseSync): void {
  const columns = columnNames(db, 'workflows')
  if (!columns.includes('work_id') && !columns.includes('adapter_json')) return
  withoutForeignKeys(db, () => {
    transaction(db, () => {
      db.exec(`
        CREATE TABLE workflows_next (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          comfy_path TEXT NOT NULL,
          current_branch TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO workflows_next
          (id, name, comfy_path, current_branch, created_at)
        SELECT id, name, comfy_path, current_branch, created_at FROM workflows;
        DROP TABLE workflows;
        ALTER TABLE workflows_next RENAME TO workflows;
      `)
    })
  })
}

function rebuildRevisions(db: DatabaseSync): void {
  if (!columnNames(db, 'workflow_revisions').includes('adapter_json')) return
  withoutForeignKeys(db, () => {
    transaction(db, () => {
      db.exec(`
        CREATE TABLE workflow_revisions_next (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          version TEXT NOT NULL,
          ui_json TEXT NOT NULL,
          api_json TEXT NOT NULL,
          message TEXT,
          created_at TEXT NOT NULL,
          UNIQUE (workflow_id, version),
          FOREIGN KEY (workflow_id) REFERENCES workflows(id)
        );
        INSERT INTO workflow_revisions_next
          (id, workflow_id, version, ui_json, api_json, message, created_at)
        SELECT id, workflow_id, version, ui_json, api_json, message, created_at
        FROM workflow_revisions;
        DROP TABLE workflow_revisions;
        ALTER TABLE workflow_revisions_next RENAME TO workflow_revisions;
      `)
    })
  })
}

function withoutForeignKeys(db: DatabaseSync, run: () => void): void {
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    run()
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((column) => column.name)
}

export function isVersionId(value: string): boolean {
  return /^[0-9a-z]{8}$/.test(value)
}

export function allocateVersion(db: DatabaseSync, workflowId: string): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let version = VERSION_LETTERS[randomInt(VERSION_LETTERS.length)] ?? 'a'
    for (let index = 0; index < 7; index += 1) {
      version += VERSION_ALPHABET[randomInt(VERSION_ALPHABET.length)]
    }
    const taken = db
      .prepare(
        'SELECT 1 FROM workflow_revisions WHERE workflow_id = ? AND version = ?',
      )
      .get(workflowId, version)
    if (!taken) return version
  }
  throw new RunnerError('could not allocate a version id')
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
