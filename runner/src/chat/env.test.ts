import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadGateway, readGateway } from './env.ts'

test('a blank gateway file stays off, and models must be a list', () => {
  assert.equal(readGateway({}), null)
  assert.throws(
    () =>
      readGateway({
        AI_GATEWAY_KEY: 'key',
        AI_GATEWAY_URL: 'http://127.0.0.1:11434/v1/',
        AI_GATEWAY_MODEL: [],
      }),
    /AI_GATEWAY_MODEL must be a list/,
  )
  assert.throws(
    () =>
      readGateway({
        AI_GATEWAY_KEY: 'key',
        AI_GATEWAY_URL: 'http://127.0.0.1:11434/v1',
        AI_GATEWAY_MODEL: 'writer',
      }),
    /AI_GATEWAY_MODEL must be a list/,
  )
  assert.deepEqual(
    readGateway({
      AI_GATEWAY_KEY: ' key ',
      AI_GATEWAY_URL: 'http://127.0.0.1:11434/v1/',
      AI_GATEWAY_MODEL: [' writer ', 'writer', 'editor'],
    }),
    {
      apiKey: 'key',
      baseURL: 'http://127.0.0.1:11434/v1',
      models: ['writer', 'editor'],
    },
  )
})

test('loads env.ts from the repo root and ignores a missing file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aigc-env-'))
  assert.equal(await loadGateway(root), null)
  writeFileSync(
    join(root, 'env.ts'),
    `export const AI_GATEWAY_KEY = 'key'
export const AI_GATEWAY_URL = 'http://127.0.0.1:11434/v1/'
export const AI_GATEWAY_MODEL = ['writer', 'editor']
`,
  )
  assert.deepEqual(await loadGateway(root), {
    apiKey: 'key',
    baseURL: 'http://127.0.0.1:11434/v1',
    models: ['writer', 'editor'],
  })
})
