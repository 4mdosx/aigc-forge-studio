import assert from 'node:assert/strict'
import { test } from 'node:test'

import { gatewayHint, type ChatTurn } from '../chat/client.ts'
import { openDatabase } from '../db.ts'
import type { Runner } from '../task/queue.ts'
import { createApp } from './app.ts'

test('a chat keeps turns and does not create a task', async () => {
  const seen: Array<{ model: string; system: string; turns: ChatTurn[] }> = []
  const runner = testRunner({
    models: ['writer', 'editor'],
    visionModel: 'seer',
    async complete(model, turns, system) {
      seen.push({
        model,
        system,
        turns: turns.map((turn) => ({
          role: turn.role,
          content: turn.content,
        })),
      })
      return seen.length === 1 ? 'red armor' : 'red armor, snow field'
    },
  })
  const app = createApp(runner)
  const created = await app.request('/chats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'a knight in red', system: 'be brief' }),
  })
  assert.equal(created.status, 201)
  const chat = (await created.json()) as {
    id: string
    title: string
    messages: Array<{ role: string; content: string }>
  }
  assert.equal(chat.title, 'a knight in red')
  assert.deepEqual(
    chat.messages.map((message) => [message.role, message.content]),
    [
      ['user', 'a knight in red'],
      ['assistant', 'red armor'],
    ],
  )
  assert.deepEqual(seen[0], {
    model: 'writer',
    system: 'be brief',
    turns: [{ role: 'user', content: 'a knight in red' }],
  })

  const next = await app.request(`/chats/${chat.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: 'snow field',
      model: 'editor',
      system: 'ask once',
    }),
  })
  assert.equal(next.status, 200)
  const body = (await next.json()) as {
    messages: Array<{ role: string; content: string }>
  }
  assert.deepEqual(
    body.messages.map((message) => message.content),
    ['a knight in red', 'red armor', 'snow field', 'red armor, snow field'],
  )
  assert.deepEqual(seen[1], {
    model: 'editor',
    system: 'ask once',
    turns: [
      { role: 'user', content: 'a knight in red' },
      { role: 'assistant', content: 'red armor' },
      { role: 'user', content: 'snow field' },
    ],
  })
  const listed = (await (await app.request('/chats')).json()) as {
    chats: Array<{ id: string }>
    models: string[]
    templates?: unknown
  }
  assert.equal(listed.chats[0]?.id, chat.id)
  assert.deepEqual(listed.models, ['writer', 'editor'])
  assert.equal(listed.templates, undefined)
  const tasks = runner.db
    .prepare('SELECT COUNT(*) AS count FROM tasks')
    .get() as {
    count: number
  }
  assert.equal(tasks.count, 0)
})

test('chat reports a missing gateway and does not keep a failed turn', async () => {
  const runner = testRunner(null)
  const app = createApp(runner)
  const missing = await app.request('/chats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'a knight' }),
  })
  assert.equal(missing.status, 503)
  assert.equal(((await missing.json()) as { error: string }).error, gatewayHint)

  runner.chat = {
    models: ['writer'],
    visionModel: 'seer',
    async complete() {
      throw new Error('down')
    },
  }
  const failed = await app.request('/chats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'a knight' }),
  })
  assert.equal(failed.status, 500)
  const listed = (await (await app.request('/chats')).json()) as {
    chats: unknown[]
  }
  assert.deepEqual(listed.chats, [])
  const rejected = await app.request('/chats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'a knight', model: 'other' }),
  })
  assert.equal(rejected.status, 400)
})

test('a message with images sends image parts and stores a marker', async () => {
  const seen: Array<{ model: string; turns: ChatTurn[] }> = []
  const runner = testRunner({
    models: ['writer', 'seer'],
    visionModel: 'seer',
    async complete(model, turns) {
      seen.push({ model, turns })
      return 'a knight'
    },
  })
  const app = createApp(runner)
  const dataUrl = 'data:image/png;base64,aGVsbG8='
  const created = await app.request('/chats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: 'look at this',
      images: [dataUrl],
      model: 'seer',
      system: 'be brief',
    }),
  })
  assert.equal(created.status, 201)
  const chat = (await created.json()) as {
    messages: Array<{
      id: string
      role: string
      content: string
      createdAt: string
    }>
  }
  assert.deepEqual(chat.messages[0], {
    id: chat.messages[0]?.id,
    role: 'user',
    content: '[图片 ×1] look at this',
    createdAt: chat.messages[0]?.createdAt,
  })
  assert.deepEqual(seen[0]?.turns, [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: 'look at this' },
      ],
    },
  ])
  const rejected = await app.request('/chats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: 'bad image',
      images: ['data:text/plain;base64,aGVsbG8='],
      model: 'seer',
      system: 'be brief',
    }),
  })
  assert.equal(rejected.status, 400)
})

function testRunner(chat: Runner['chat']): Runner {
  return {
    db: openDatabase(':memory:'),
    clients: [],
    chat,
    dataDir: '/tmp/aigc-runner-test-data',
    timeoutMs: 60_000,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    randomSeed: () => 1,
  }
}
