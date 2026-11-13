import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { findRepoRoot, loadConfig } from './config.ts'

const root = findRepoRoot([import.meta.dirname])

test('reads comfyui and runner from config.json', () => {
  const path = join(root, 'config.json')
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    comfyui: { baseURL: string }
    runner: {
      comfyUiBaseURL?: string
      host: string
      port: number
      timeout: number
      out: string
      db: string
    }
  }
  const config = loadConfig(path)
  const configured = raw.runner.comfyUiBaseURL?.trim().replace(/\/+$/, '')
  assert.equal(config.comfyui.baseURL, raw.comfyui.baseURL.replace(/\/+$/, ''))
  assert.deepEqual(config.runner.comfyUiBaseURLs, [
    configured || config.comfyui.baseURL,
  ])
  assert.match(config.runner.comfyUiBaseURLs[0] ?? '', /^https?:\/\/[^/]+/)
  assert.equal(config.runner.host, raw.runner.host)
  assert.equal(config.runner.port, raw.runner.port)
  assert.equal(config.runner.timeout, raw.runner.timeout)
  assert.equal(config.runner.out, raw.runner.out)
  assert.equal(config.runner.db, raw.runner.db)
})

test('runner uses comfyui.baseURL when comfyUiBaseURL is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aigc-config-'))
  const path = join(dir, 'config.json')
  writeFileSync(
    path,
    JSON.stringify({
      comfyui: { baseURL: 'http://192.168.8.136:8188/' },
      runner: {
        comfyUiBaseURL: '  ',
        host: '127.0.0.1',
        port: 8787,
        timeout: 600,
        out: 'outputs/runner',
      },
    }),
  )
  const config = loadConfig(path)
  assert.deepEqual(config.runner.comfyUiBaseURLs, ['http://192.168.8.136:8188'])
  assert.equal(config.runner.db, 'data/runner.sqlite')
})
