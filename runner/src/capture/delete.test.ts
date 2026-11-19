import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openDatabase } from '../db.ts'
import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'
import { deleteAsset } from './asset.ts'

const HASH = 'a'.repeat(64)

test('delete removes the hash directories, the job, and the row', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'capture-delete-'))
  const raw = join(dataDir, 'capture', 'raw', HASH)
  const assets = join(dataDir, 'capture', 'assets', HASH)
  const neighbor = join(dataDir, 'capture', 'raw', 'b'.repeat(64))
  mkdirSync(raw, { recursive: true })
  mkdirSync(assets, { recursive: true })
  mkdirSync(neighbor, { recursive: true })
  writeFileSync(join(raw, 'original.jpg'), 'raw')
  writeFileSync(join(assets, 'processed.png'), 'prep')
  writeFileSync(join(neighbor, 'original.jpg'), 'keep')

  const db = openDatabase(':memory:')
  db.prepare(
    `INSERT INTO image_assets (
      id, status, source_type, source_url, img_url,
      original_path, original_width, original_height, hash,
      tags_json, embedding_json, tags_model_version, embedding_model_version,
      reviewed_at, created_at, updated_at
    ) VALUES ('asset-1', 'processed', 'manual', '', '', ?, 2, 2, ?, '[]', '[]', '', '', 0, 1, 1)`,
  ).run(`capture/raw/${HASH}/original.jpg`, HASH)
  db.prepare(
    `INSERT INTO jobs (
      id, kind, asset_id, status, step, attempts, max_attempts, next_run_at, created_at
    ) VALUES ('job-1', 'capture.process', 'asset-1', 'pending', 'prepare', 0, 5, 1, 1)`,
  ).run()

  deleteAsset(runner(db, dataDir), 'asset-1')

  assert.equal(existsSync(raw), false)
  assert.equal(existsSync(assets), false)
  assert.equal(existsSync(join(neighbor, 'original.jpg')), true)
  assert.equal(db.prepare('SELECT id FROM image_assets WHERE id = ?').get('asset-1'), undefined)
  assert.equal(db.prepare('SELECT id FROM jobs WHERE asset_id = ?').get('asset-1'), undefined)
  assert.throws(() => deleteAsset(runner(db, dataDir), 'asset-1'), RunnerError)
})

function runner(db: Runner['db'], dataDir: string): Runner {
  return { db, dataDir, now: () => new Date('2026-01-02T00:00:00.000Z') } as Runner
}
