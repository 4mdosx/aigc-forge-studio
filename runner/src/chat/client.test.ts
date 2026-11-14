import assert from 'node:assert/strict'
import { test } from 'node:test'

import { gatewayChat } from './client.ts'

test('the gateway client only calls a model from the list', async () => {
  const client = gatewayChat({
    apiKey: 'key',
    baseURL: 'http://127.0.0.1:11434/v1',
    models: ['writer', 'editor'],
    visionModel: 'seer',
  })
  assert.deepEqual(client.models, ['writer', 'editor'])
  assert.equal(client.visionModel, 'seer')
  await assert.rejects(
    () => client.complete('other', [{ role: 'user', content: 'a knight' }], ''),
    /model is not available/,
  )
})
