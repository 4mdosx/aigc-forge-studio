import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildCooccur,
  parseTagList,
  readTagTable,
  recommendTags,
} from './cooccur.ts'

const fixed = () => 0.5

test('parseTagList splits commas, drops empties and dedupes', () => {
  assert.deepEqual(
    parseTagList('animal_ears, animal ear fluff, pointy_ears, animal_ears,'),
    ['animal_ears', 'animal_ear_fluff', 'pointy_ears'],
  )
})

test('buildCooccur counts a tag once per file and drops pairs seen once', () => {
  const index = buildCooccur({
    a: 'animal_ears, fox_ears, animal_ears',
    b: 'animal_ears, fox_ears',
    c: 'animal_ears, once_tag',
    d: '',
  })
  assert.equal(index.n, 3)
  assert.equal(index.df.get('animal_ears'), 3)
  assert.equal(index.df.get('fox_ears'), 2)
  assert.equal(index.pairs.get('animal_ears')?.get('fox_ears'), 2)
  assert.equal(index.pairs.get('animal_ears')?.has('once_tag'), false)
})

test('recommendTags sums the query group and skips the query tags', () => {
  const index = buildCooccur({
    a: 'animal_ears, animal_ear_fluff, fox_ears',
    b: 'animal_ears, animal_ear_fluff, fox_ears',
    c: 'animal_ears, pointy_ears, elf',
    d: 'animal_ears, pointy_ears, elf',
    e: '1girl, solo, long_hair',
    f: '1girl, solo, smile',
    g: '1girl, long_hair, smile',
  })
  const picked = recommendTags(
    index,
    ['animal_ears', 'animal_ear_fluff', 'animal_ears', 'pointy_ears'],
    { random: fixed },
  )
  assert.deepEqual(picked, ['elf', 'fox_ears'])
})

test('a negative weight pushes partners of that tag down and out of the list', () => {
  const index = buildCooccur({
    a: 'animal_ears, cat_ears, blush',
    b: 'animal_ears, cat_ears, blush',
    c: 'animal_ears, fox_ears',
    d: 'animal_ears, fox_ears',
    e: '1girl, solo',
  })
  const plain = recommendTags(index, ['animal_ears'], { random: fixed })
  const down = recommendTags(index, ['animal_ears'], {
    random: fixed,
    weights: { blush: -1 },
  })
  assert.deepEqual(plain, ['blush', 'cat_ears', 'fox_ears'])
  assert.deepEqual(down, ['fox_ears', 'cat_ears'])
})

test('a repeated partner outranks a tag that only co-occurs twice', () => {
  const docs: Record<string, string> = {}
  for (let i = 0; i < 12; i += 1)
    docs[`often-${i}`] = 'query_tag, often_tag, extra'
  for (let i = 0; i < 6; i += 1) docs[`only-${i}`] = 'query_tag, extra'
  docs.rare1 = 'query_tag, rare_tag'
  docs.rare2 = 'query_tag, rare_tag'
  for (let i = 0; i < 10; i += 1) docs[`other-${i}`] = 'filler_a, filler_b'
  const index = buildCooccur(docs)
  const picked = recommendTags(index, ['query_tag'], { random: fixed })
  assert.equal(picked[0], 'often_tag')
  assert.ok(picked.indexOf('often_tag') < picked.indexOf('rare_tag'))
})

test('tags on more than half the images are left out', () => {
  const index = buildCooccur({
    a: 'ribbon, bow, 1girl',
    b: 'ribbon, bow, 1girl',
    c: 'ribbon, bow, 1girl',
    d: 'ribbon, 1girl',
    e: '1girl, solo',
    f: '1girl, hat',
  })
  const picked = recommendTags(index, ['ribbon'], { random: fixed })
  assert.deepEqual(picked, ['bow'])
})

test('readTagTable accepts filename → tag string', () => {
  const table = readTagTable('{"a.png":"tag1,tag2,tag,","b.png":"solo"}')
  assert.deepEqual(table, { 'a.png': 'tag1,tag2,tag,', 'b.png': 'solo' })
  assert.throws(() => readTagTable('["tag"]'), /object of filename/)
  assert.throws(() => readTagTable('{"a.png":["tag"]}'), /comma-separated/)
})
