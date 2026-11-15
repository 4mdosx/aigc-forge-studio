import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TrainerError } from './errors.ts'
import { buildRoots, resolveInRoot } from './roots.ts'

test('buildRoots validates names and absolute paths, skips // keys', () => {
  const roots = buildRoots({
    models: 'C:\\ComfyUI\\models',
    training: '/data/training',
    '//roots': '注释键被跳过',
  })
  assert.deepEqual(roots, {
    models: 'C:\\ComfyUI\\models',
    training: '/data/training',
  })
})

test('buildRoots rejects bad names, relative paths, non-object', () => {
  assert.throws(() => buildRoots({ '9bad': '/x' }))
  assert.throws(() => buildRoots({ 'bad name': '/x' }))
  assert.throws(() => buildRoots({ models: './relative' }))
  assert.throws(() => buildRoots({ models: '' }))
  assert.throws(() => buildRoots([1, 2]))
  assert.throws(() => buildRoots({ models: 42 }))
})

test('buildRoots accepts missing roots', () => {
  assert.deepEqual(buildRoots(undefined), {})
})

test('resolveInRoot joins and rejects unknown/escaped paths', () => {
  const roots = buildRoots({ models: '/tmp/trainer-x/models' })
  assert.equal(
    resolveInRoot(roots, 'models', ['text_encoders', 'a.bin']),
    '/tmp/trainer-x/models/text_encoders/a.bin',
  )
  assert.throws(() => resolveInRoot(roots, 'nope', ['a.bin']), (err: unknown) => {
    return err instanceof TrainerError && err.status === 404
  })
  assert.throws(() => resolveInRoot(roots, '9bad', ['a.bin']))
})
