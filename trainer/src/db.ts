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
  completed_at TEXT
);
`

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(path.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)
  return db
}
