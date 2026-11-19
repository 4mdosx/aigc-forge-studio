import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '../db.ts'
import type { Runner } from '../task/queue.ts'
import { createApp } from './app.ts'

test('roll_config defaults and round-trips', async () => {
  const app = createApp(testRunner())
  const got = await app.request('/config/roll_config')
  assert.equal(got.status, 200)
  const body = (await got.json()) as { key: string; value: Record<string, string> }
  assert.equal(body.key, 'roll_config')
  assert.equal(body.value.workflowName, 'baseline_v1')
  assert.equal(body.value.version, 'g3317g3t')
  assert.equal(body.value.step, '1200')
  assert.equal(body.value.workflowPositive, '')
  assert.equal(body.value.workflowNegative, '')

  const saved = await app.request('/config/roll_config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workflowName: 'other_v1',
      version: '',
      step: '600',
      workflowPositive: 'masterpiece',
      workflowNegative: 'lowres',
    }),
  })
  assert.equal(saved.status, 200)
  const again = (await (await app.request('/config/roll_config')).json()) as {
    value: Record<string, string>
  }
  assert.deepEqual(again.value, {
    workflowName: 'other_v1',
    version: '',
    step: '600',
    workflowPositive: 'masterpiece',
    workflowNegative: 'lowres',
  })
})

test('roll_config rejects a blank workflowName', async () => {
  const app = createApp(testRunner())
  const saved = await app.request('/config/roll_config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workflowName: '  ',
      step: '1200',
      workflowPositive: '',
      workflowNegative: '',
    }),
  })
  assert.equal(saved.status, 400)
})

function testRunner(): Runner {
  return {
    db: openDatabase(':memory:'),
    clients: [],
    chat: null,
    trainerBaseURL: null,
    dataDir: '/tmp/aigc-runner-test-data',
    timeoutMs: 600_000,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    randomSeed: () => 42,
  }
}
