import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { findRepoRoot, loadConfig } from './config.ts'

const root = findRepoRoot([import.meta.dirname])

test('reads baseURL from infra/config.json', () => {
  const path = join(root, 'infra', 'config.json')
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { baseURL: string }
  const config = loadConfig(path)
  assert.equal(config.baseURL, raw.baseURL.replace(/\/+$/, ''))
  assert.match(config.baseURL, /^https?:\/\/[^/]+/)
})
