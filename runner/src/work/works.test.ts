import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '../db.ts'
import { RunnerError } from '../errors.ts'
import { parseAdapter } from '../workflow/binding.ts'
import { createWork, saveWork, updateSemantic, workByName } from './works.ts'

const semantic = {
  inputs: {
    text: { type: 'string' },
    seed: { type: 'seed' },
  },
}

test('renames a work and keeps its id', () => {
  const db = openDatabase(':memory:')
  const created = createWork(
    db,
    'picture',
    semantic,
    new Date('2026-01-01T00:00:00.000Z'),
  )
  const saved = saveWork(db, 'picture', 'portrait', semantic)
  assert.equal(saved.id, created.id)
  assert.equal(saved.name, 'portrait')
  assert.equal(workByName(db, 'portrait').id, created.id)
  assert.throws(() => workByName(db, 'picture'), RunnerError)
})

test('rejects a duplicate work name and keeps the old one', () => {
  const db = openDatabase(':memory:')
  const now = new Date('2026-01-01T00:00:00.000Z')
  createWork(db, 'picture', semantic, now)
  createWork(db, 'portrait', semantic, now)
  assert.throws(
    () => saveWork(db, 'picture', 'portrait', semantic),
    (err: unknown) =>
      err instanceof RunnerError &&
      err.message === 'work portrait already exists',
  )
  assert.equal(workByName(db, 'picture').name, 'picture')
})

test('keeps the old name when the new fields are invalid', () => {
  const db = openDatabase(':memory:')
  createWork(db, 'picture', semantic, new Date('2026-01-01T00:00:00.000Z'))
  assert.throws(() => saveWork(db, 'picture', 'portrait', {}), RunnerError)
  assert.equal(workByName(db, 'picture').name, 'picture')
  assert.throws(() => workByName(db, 'portrait'), RunnerError)
})
