import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseTagsCsv, selectTags } from './wd14.ts'

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
})

test('selectTags excludeTags matches case and underscores loosely', () => {
  const scores = [0.9, 0, 0, 0, 0, 0, 0.9, 0.5, 0, 0]
  const result = selectTags(scores, sampleEntries, {
    excludeTags: ['GENERAL', 'Rating_Explicit'],
  })
  assert.deepEqual(result.tags, ['1girl'])
  assert.equal(result.rating, 'rating_explicit')
})

test('selectTags throws when output size mismatches csv rows', () => {
  assert.throws(() => selectTags([0.1, 0.2], sampleEntries), /output size 2/)
})
