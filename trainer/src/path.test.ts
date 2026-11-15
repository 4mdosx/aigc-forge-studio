import assert from 'node:assert/strict'
import { test } from 'node:test'

import { relativePath } from './path.ts'

test('accepts plain relative paths', () => {
  assert.equal(relativePath('a/b/c.bin'), 'a/b/c.bin')
  assert.equal(relativePath('file.bin'), 'file.bin')
  assert.equal(relativePath('a/b/c%20d.bin'), 'a/b/c d.bin')
})

test('rejects traversal and absolute paths', () => {
  for (const bad of [
    '',
    '..',
    '../x',
    'a/../b',
    'a/./b',
    '/abs/path',
    'C:/x',
    'C:\\x',
    'a\\b',
    'a//b',
    'a/\0b',
    'a/b/',
  ]) {
    assert.throws(() => relativePath(bad), `should reject: ${bad}`)
  }
})
