import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openDatabase } from '../db.ts'
import { tagLine, tagTableFromRows, writeWd14TagTable } from './table.ts'

test('tag line keeps order, drops blanks, and ends with a comma', () => {
  assert.equal(tagLine([' 1girl ', 'solo', '1girl', '']), '1girl,solo,')
  assert.equal(tagLine([]), '')
})

test('tag table uses image_assets ids and ignores a bad tags column', () => {
  assert.deepEqual(
    tagTableFromRows([
      { id: 'a', tags_json: '["solo","1girl"]' },
      { id: 'b', tags_json: 'not-json' },
      { id: '', tags_json: '["solo"]' },
    ]),
    { a: 'solo,1girl,', b: '' },
  )
})

test('writeWd14TagTable rewrites the file from image_assets only', () => {
  const db = openDatabase(':memory:')
  db.prepare(
    `INSERT INTO image_assets (
      id, status, source_type, source_url, img_url,
      original_path, original_width, original_height, hash,
      tags_json, embedding_json, tags_model_version, embedding_model_version,
      reviewed_at, created_at, updated_at
    ) VALUES
      ('later', 'processed', 'manual', '', '', 'a', 1, 1, '${'a'.repeat(64)}', '["dress"]', '[]', '', '', 0, 2, 2),
      ('earlier', 'processed', 'manual', '', '', 'b', 1, 1, '${'b'.repeat(64)}', '["solo","1girl"]', '[]', '', '', 0, 1, 1)`,
  ).run()
  const dir = mkdtempSync(join(tmpdir(), 'wd14-table-'))
  writeWd14TagTable(db, dir)
  const written = JSON.parse(readFileSync(join(dir, 'wd14-tags.json'), 'utf8')) as Record<
    string,
    string
  >
  assert.deepEqual(Object.keys(written), ['earlier', 'later'])
  assert.equal(written.earlier, 'solo,1girl,')
  assert.equal(written.later, 'dress,')
})
