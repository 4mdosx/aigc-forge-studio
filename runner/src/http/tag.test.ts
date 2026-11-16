import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseTagText } from './tag.ts'

test('parseTagText splits on commas, newlines and semicolons', () => {
  assert.deepEqual(parseTagText('a, b,c\n d; e'), ['a', 'b', 'c', 'd', 'e'])
})

test('parseTagText trims, drops empties and dedupes keeping order', () => {
  assert.deepEqual(parseTagText('1girl, , long hair, 1girl , long hair'), [
    '1girl',
    'long hair',
  ])
  assert.deepEqual(parseTagText('   '), [])
  assert.deepEqual(parseTagText(''), [])
})
