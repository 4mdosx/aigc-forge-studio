import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PNG } from 'pngjs'

import { openDatabase } from '../db.ts'
import type { Runner } from '../task/queue.ts'
import { replaceNobg } from './asset.ts'

test('replaceNobg overwrites the cutout and keeps its size', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'capture-nobg-'))
  const db = openDatabase(':memory:')
  const rel = 'capture/raw/abc/nobg.png'
  mkdir(dataDir, 'capture/raw/abc')
  writeFileSync(join(dataDir, rel), png(2, 2, () => [0, 0, 0, 0]))
  db.prepare(
    `INSERT INTO image_assets (
      id, status, source_type, source_url, img_url,
      original_path, original_width, original_height, hash,
      nobg_path, nobg_width, nobg_height,
      tags_json, embedding_json, tags_model_version, embedding_model_version,
      reviewed_at, created_at, updated_at
    ) VALUES ('asset-1', 'processed', 'manual', '', '', ?, 2, 2, 'abc', ?, 2, 2, '[]', '[]', '', '', 0, 1, 1)`,
  ).run('capture/raw/abc/original.png', rel)
  const runner = {
    db,
    dataDir,
    now: () => new Date('2026-01-02T00:00:00.000Z'),
  } as Runner

  const next = replaceNobg(runner, 'asset-1', png(2, 2, (x) => (x === 0 ? [9, 0, 0, 255] : [0, 0, 0, 0])))
  assert.equal(next.nobg?.width, 2)
  assert.equal(next.nobg?.height, 2)
  const saved = PNG.sync.read(readFileSync(join(dataDir, rel)))
  assert.equal(saved.data[0], 9)
  assert.equal(saved.data[7], 0)
})

function png(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const image = new PNG({ width, height })
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (width * y + x) << 2
      const [r, g, b, a] = paint(x, y)
      image.data[idx] = r
      image.data[idx + 1] = g
      image.data[idx + 2] = b
      image.data[idx + 3] = a
    }
  }
  return PNG.sync.write(image)
}

function mkdir(root: string, rel: string): void {
  mkdirSync(join(root, rel), { recursive: true })
}
