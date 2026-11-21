import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadCategoryMap, parseTagsCsv, selectTags } from './wd14.ts'

function entriesOf(rows: Array<[string, number]>): Array<{ name: string; category: number }> {
  return rows.map(([name, category]) => ({ name, category }))
}

const sampleEntries = entriesOf([
  ['general', 0], // 0
  ['artist', 1], // 1
  ['copyright', 3], // 2
  ['character', 4], // 3
  ['general', 9], // 4（rating 类目值 9）
  ['long_hair', 0], // 5
  ['1girl', 0], // 6
  ['rating_explicit', 9], // 7
  ['another_char', 4], // 8
  ['watermark', 9], // 9
])

test('parseTagsCsv skips header and reads name/category columns', () => {
  const csv = 'tag_id,name,category,count\n0,1girl,0,100000\n1,long_hair,0,90000\n2,hatsune_miku,4,5000\n'
  const entries = parseTagsCsv(csv)
  assert.deepEqual(entries, [
    { name: '1girl', category: 0 },
    { name: 'long_hair', category: 0 },
    { name: 'hatsune_miku', category: 4 },
  ])
  assert.throws(() => parseTagsCsv('tag_id,name,category,count\n'), /no rows/)
})

test('selectTags filters by category thresholds and sorts by confidence', () => {
  // 对应 sampleEntries 逐位打分
  const scores = [0.9, 0.7, 0.8, 0.95, 0.1, 0.5, 0.36, 0.9, 0.84, 0.6]
  const result = selectTags(scores, sampleEntries, {
    generalThreshold: 0.35,
    characterThreshold: 0.85,
  })
  // artist(0.7)/copyright(0.8) 永不入选；rating 不进 tags
  // general: 0.9 / 0.5 / 0.36 入选，按分降序
  // character: 0.95 入选，0.84 低于阈值淘汰
  assert.deepEqual(result.tags, ['character', 'general', 'long_hair', '1girl'])
  assert.equal(result.rating, 'rating_explicit')
  // details 含 artist/copyright/rating 及低分 character，按分降序
  assert.deepEqual(
    result.details.map((item) => item.name),
    [
      'character', 'general', 'rating_explicit', 'another_char',
      'copyright', 'artist', 'watermark', 'long_hair', '1girl', 'general',
    ],
  )
  assert.equal(result.details.find((item) => item.name === 'artist')?.category, 1)
  assert.equal(result.details.find((item) => item.name === 'rating_explicit')?.category, 9)
})

test('selectTags excludeTags matches case and underscores loosely', () => {
  const scores = [0.9, 0, 0, 0, 0, 0, 0.9, 0.5, 0, 0]
  const result = selectTags(scores, sampleEntries, {
    excludeTags: ['GENERAL', 'Rating_Explicit'],
  })
  assert.deepEqual(result.tags, ['1girl'])
  assert.equal(result.rating, 'rating_explicit')
  // exclude 的 general(cat0) 不进 details；rating 类(cat9) 都进 details（只是不进 caption）
  assert.deepEqual(result.details.map((item) => item.name), [
    '1girl', 'rating_explicit', 'general', 'watermark',
  ])
})

test('selectTags throws when output size mismatches csv rows', () => {
  assert.throws(() => selectTags([0.1, 0.2], sampleEntries), /output size 2/)
})

test('loadCategoryMap reads csv without loading onnx, caches by dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'wd14-map-'))
  const dir = join(root, 'wd14', 'wd-eva02-large-tagger-v3')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'selected_tags.csv'),
    'tag_id,name,category,count\n0,1girl,0,100\n1,hatsune_miku,4,50\n2,solo,0,90\n',
    'utf8',
  )
  const map = loadCategoryMap(root, 'wd-eva02-large-tagger-v3')
  assert.equal(map.get('1girl'), 0)
  assert.equal(map.get('hatsune_miku'), 4)
  assert.equal(map.get('solo'), 0)
  assert.equal(map.get('missing'), undefined)
  assert.equal(loadCategoryMap(root, 'wd-eva02-large-tagger-v3'), map) // 同一引用=命中缓存
})
