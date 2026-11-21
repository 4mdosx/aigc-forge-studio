import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  root TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled')),
  bytes_done INTEGER NOT NULL DEFAULT 0,
  bytes_total INTEGER,
  resumed_from INTEGER,
  sha256 TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE (url, root, path)
);

CREATE TABLE IF NOT EXISTS train_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled')),
  params TEXT NOT NULL,
  dataset_toml TEXT,
  train_toml TEXT,
  output_dir TEXT,
  exit_code INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  paused_at TEXT,
  pid INTEGER
);
`

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(path.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)
  migrate(db)
  return db
}

// 暂停不新增状态值（status 有 CHECK 约束，改它要重建表），
// 只用 paused_at 标记：status 仍是 running，单任务锁天然继续生效。
// pid 同理不改进程管理语义，只是让 trainer 重启后能 re-attach 还活着的训练进程。
function migrate(db: DatabaseSync): void {
  ensureColumn(db, 'train_jobs', 'paused_at', 'TEXT')
  ensureColumn(db, 'train_jobs', 'pid', 'INTEGER')
}

function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  type: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string
  }>
  if (columns.some((entry) => entry.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
}
