import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '../db.ts'
import {
  captureTaskKey,
  enqueueDownload,
  enqueueNobg,
  listCaptureTasks,
  resumeCaptureTasks,
  retryCaptureTask,
} from './tasks.ts'

function insertAsset(
  db: ReturnType<typeof openDatabase>,
  id: string,
  hash: string,
  nobgPath: string | null = null,
): void {
  db.prepare(
    `INSERT INTO image_assets (
      id, status, source_type, source_url, img_url, original_path,
      original_width, original_height, hash, processed_path,
      processed_width, processed_height, nobg_path, nobg_width, nobg_height,
      created_at, updated_at
    ) VALUES (?, 'processed', 'crawler', ?, '', 'capture/raw/x/original.jpg', 10, 10, ?,
      'capture/processed.png', 10, 10, ?, 10, 10, 0, 0)`,
  ).run(id, 'https://www.pinterest.com/pin/seed/', hash, nobgPath)
}

test('captureTaskKey drops tracking params and converges pixiv artworks', () => {
  assert.equal(
    captureTaskKey('https://www.pinterest.com/pin/123/?x=1#top'),
    'https://www.pinterest.com/pin/123',
  )
  assert.equal(
    captureTaskKey('https://www.pixiv.net/en/artworks/42?utm=1'),
    'https://www.pixiv.net/artworks/42',
  )
  assert.notEqual(
    captureTaskKey('https://i.pximg.net/img-original/img/a/1_p0.jpg'),
    captureTaskKey('https://i.pximg.net/img-original/img/a/1_p1.jpg'),
  )
})

test('download tasks dedupe against assets and queued tasks', () => {
  const db = openDatabase(':memory:')
  insertAsset(db, 'a1', 'hash1')
  const first = enqueueDownload(
    db,
    { url: 'https://www.pinterest.com/pin/a1/' },
    1_000,
  )
  assert.equal(first.duplicate, false)
  assert.equal(first.task?.status, 'pending')
  assert.equal(
    enqueueDownload(db, { url: 'https://www.pinterest.com/pin/a1/?x=2' }, 1_001)
      .duplicate,
    true,
  )
  assert.equal(
    enqueueDownload(db, { url: 'https://www.pinterest.com/pin/unknown/' }, 1_002)
      .duplicate,
    false,
  )
})

test('nobg tasks skip assets that already have a cutout', () => {
  const db = openDatabase(':memory:')
  insertAsset(db, 'a1', 'hash1', 'capture/assets/hash1/nobg.png')
  insertAsset(db, 'a2', 'hash2')
  assert.equal(enqueueNobg(db, 'a1', 1_000).skipped, true)
  const result = enqueueNobg(db, 'a2', 1_001)
  assert.equal(result.skipped, false)
  assert.equal(result.task?.kind, 'nobg')
  assert.equal(enqueueNobg(db, 'a2', 1_002).skipped, true)
})

test('list, resume and retry keep task state in sqlite', () => {
  const db = openDatabase(':memory:')
  insertAsset(db, 'a1', 'hash1')
  const { task } = enqueueDownload(
    db,
    { url: 'https://www.pinterest.com/pin/x/' },
    1_000,
  )
  assert.ok(task)
  assert.equal(listCaptureTasks(db).counts.download.pending, 1)
  db.prepare(
    `UPDATE capture_tasks SET status = 'running', started_at = 0, attempts = 1 WHERE id = ?`,
  ).run(task.id)
  resumeCaptureTasks(db, 2_000)
  assert.equal(listCaptureTasks(db).counts.download.pending, 1)
  db.prepare(`UPDATE capture_tasks SET status = 'failed', error = 'boom' WHERE id = ?`).run(
    task.id,
  )
  assert.equal(retryCaptureTask(db, task.id, 3_000).status, 'pending')
  assert.equal(listCaptureTasks(db).counts.download.failed, 0)
})
