import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PNG } from 'pngjs'

import { writeThumb } from './asset.ts'

test('thumbnail fits the long edge to 320', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-thumb-'))
  const source = join(dir, 'processed.png')
  const dest = join(dir, 'thumb.png')
  const png = new PNG({ width: 640, height: 320, colorType: 2 })
  png.data.fill(255)
  writeFileSync(source, PNG.sync.write(png))

  await writeThumb(source, dest)

  const thumb = PNG.sync.read(readFileSync(dest))
  assert.equal(thumb.width, 320)
  assert.equal(thumb.height, 160)
  assert.equal(PNG.sync.read(readFileSync(source)).width, 640)
})
