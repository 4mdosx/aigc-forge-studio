import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PNG } from 'pngjs'

import { openDatabase } from '../db.ts'
import type { Runner } from '../task/queue.ts'
import { approveAsset, settleFinalFiles } from './asset.ts'

test('approve keeps the selected version and drops the others', async () => {
  const processed = tempDir()
  writeSet(processed)
  const keptProcessed = await settleFinalFiles(processed, 'processed', 'processed.png', 'original.jpg')
  assert.equal(keptProcessed.name, 'processed.png')
  assert.equal(readFileSync(join(processed, 'processed.png'), 'utf8'), 'prep')
  assert.deepEqual(readdirSync(processed).sort(), ['processed.png'])

  const raw = tempDir()
  writeSet(raw)
  const keptRaw = await settleFinalFiles(raw, 'raw', 'processed.png', 'original.jpg')
  assert.equal(keptRaw.name, 'original.jpg')
  assert.equal(readFileSync(join(raw, 'original.jpg'), 'utf8'), 'raw')
  assert.deepEqual(readdirSync(raw).sort(), ['original.jpg'])
})

test('settle leaves the existing thumbnail file', async () => {
  const processed = tempDir()
  writeSet(processed)
  writeFileSync(join(processed, 'thumb.png'), 'thumb')
  await settleFinalFiles(processed, 'processed', 'processed.png', 'original.jpg')
  assert.equal(readFileSync(join(processed, 'thumb.png'), 'utf8'), 'thumb')

  const raw = tempDir()
  writeSet(raw)
  writeFileSync(join(raw, 'thumb.png'), 'thumb')
  await settleFinalFiles(raw, 'raw', 'processed.png', 'original.jpg')
  assert.equal(readFileSync(join(raw, 'thumb.png'), 'utf8'), 'thumb')
  assert.deepEqual(readdirSync(raw).sort(), ['original.jpg', 'thumb.png'])

  const nobg = tempDir()
  writeFileSync(join(nobg, 'original.jpg'), 'raw')
  writePng(join(nobg, 'processed.png'), 4, 2, () => [10, 10, 10, 255])
  writePng(join(nobg, 'nobg.png'), 2, 1, (x) => (x === 0 ? [200, 0, 0, 255] : [200, 0, 0, 0]))
  writeFileSync(join(nobg, 'thumb.png'), 'thumb')
  await settleFinalFiles(nobg, 'nobg', 'processed.png', 'original.jpg')
  assert.equal(readFileSync(join(nobg, 'thumb.png'), 'utf8'), 'thumb')
  assert.deepEqual(readdirSync(nobg).sort(), ['processed.png', 'thumb.png'])
})

test('approve rewrites the thumbnail from the kept file', async () => {
  const dataDir = tempDir()
  const hash = 'c'.repeat(64)
  const dir = join(dataDir, 'capture', 'raw', hash)
  mkdirSync(dir, { recursive: true })
  writePng(join(dir, 'original.png'), 640, 480, () => [0, 0, 255, 255])
  writePng(join(dir, 'processed.png'), 400, 200, () => [255, 0, 0, 255])
  writeFileSync(join(dir, 'thumb.png'), 'stale')

  const db = openDatabase(':memory:')
  db.prepare(
    `INSERT INTO image_assets (
      id, status, source_type, source_url, img_url,
      original_path, original_width, original_height, hash,
      processed_path, processed_width, processed_height,
      tags_json, embedding_json, tags_model_version, embedding_model_version,
      reviewed_at, created_at, updated_at
    ) VALUES (
      'asset-1', 'processed', 'manual', '', '',
      ?, 640, 480, ?,
      ?, 400, 200,
      '[]', '[]', '', '',
      0, 1, 1
    )`,
  ).run(
    `capture/raw/${hash}/original.png`,
    hash,
    `capture/raw/${hash}/processed.png`,
  )

  const approved = await approveAsset(runner(db, dataDir), 'asset-1', 'raw')
  const thumb = PNG.sync.read(readFileSync(join(dataDir, 'capture', 'assets', hash, 'thumb.png')))
  assert.equal(thumb.width, 320)
  assert.equal(thumb.height, 240)
  assert.equal(approved.thumbUrl, `/capture/file/assets/${hash}/thumb.png`)
})

test('nobg approve flattens onto white at the pre-cutout size', async () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'original.jpg'), 'raw')
  writePng(join(dir, 'processed.png'), 4, 2, () => [10, 10, 10, 255])
  writePng(join(dir, 'nobg.png'), 2, 1, (x) => (x === 0 ? [200, 0, 0, 255] : [200, 0, 0, 0]))

  const kept = await settleFinalFiles(dir, 'nobg', 'processed.png', 'original.jpg')
  assert.equal(kept.name, 'processed.png')
  assert.equal(kept.width, 4)
  assert.equal(kept.height, 2)
  assert.deepEqual(readdirSync(dir).sort(), ['processed.png'])

  const png = PNG.sync.read(readFileSync(join(dir, 'processed.png')))
  assert.equal(png.width, 4)
  assert.equal(png.height, 2)
  assert.deepEqual(pixel(png, 0, 0), [200, 0, 0, 255])
  assert.deepEqual(pixel(png, 3, 1), [255, 255, 255, 255])
})

function writeSet(dir: string): void {
  writeFileSync(join(dir, 'original.jpg'), 'raw')
  writeFileSync(join(dir, 'processed.png'), 'prep')
  writeFileSync(join(dir, 'nobg.png'), 'cut')
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'capture-final-'))
}

function runner(db: Runner['db'], dataDir: string): Runner {
  return { db, dataDir, now: () => new Date('2026-01-02T00:00:00.000Z') } as Runner
}

function writePng(
  file: string,
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number],
): void {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (width * y + x) << 2
      const [r, g, b, a] = paint(x, y)
      png.data[idx] = r
      png.data[idx + 1] = g
      png.data[idx + 2] = b
      png.data[idx + 3] = a
    }
  }
  writeFileSync(file, PNG.sync.write(png))
}

function pixel(png: PNG, x: number, y: number): number[] {
  const idx = (png.width * y + x) << 2
  return [png.data[idx], png.data[idx + 1], png.data[idx + 2], png.data[idx + 3]]
}
