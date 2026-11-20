import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CaptureLive, type LiveSocket } from './live.ts'

function peer(): { socket: LiveSocket; messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    socket: {
      send(text) {
        messages.push(JSON.parse(text))
      },
    },
  }
}

function last(messages: unknown[]): Record<string, unknown> {
  const message = messages.at(-1)
  assert.ok(message && typeof message === 'object')
  return message as Record<string, unknown>
}

test('web is ready only after it says so, and leaving clears it', () => {
  const live = new CaptureLive()
  const web = peer()
  const extension = peer()
  const webId = live.attach(web.socket)
  const extensionId = live.attach(extension.socket)

  live.receive(webId, JSON.stringify({ type: 'hello', role: 'web' }))
  live.receive(
    extensionId,
    JSON.stringify({ type: 'hello', role: 'extension' }),
  )
  assert.equal(last(web.messages).webReady, false)
  assert.equal(last(extension.messages).extensions, 1)

  live.receive(webId, JSON.stringify({ type: 'ready', ready: true }))
  assert.equal(last(extension.messages).webReady, true)
  assert.deepEqual(live.snapshot(), { webReady: true, webs: 1, extensions: 1 })

  live.detach(webId)
  assert.equal(last(extension.messages).webReady, false)
  assert.equal(last(extension.messages).webs, 0)
})

test('capture is rejected until a capture page is ready', () => {
  const live = new CaptureLive()
  const web = peer()
  const extension = peer()
  const webId = live.attach(web.socket)
  const extensionId = live.attach(extension.socket)
  live.receive(webId, JSON.stringify({ type: 'hello', role: 'web' }))
  live.receive(
    extensionId,
    JSON.stringify({ type: 'hello', role: 'extension' }),
  )

  live.receive(
    extensionId,
    JSON.stringify({
      type: 'capture',
      id: 'job-1',
      url: 'https://www.pixiv.net/artworks/42',
    }),
  )
  assert.equal(
    web.messages.some((item) => isType(item, 'capture')),
    false,
  )
  assert.equal(last(extension.messages).state, 'rejected')
  assert.equal(last(extension.messages).message, '采集页未打开')
})

test('a ready capture page receives the url, then its progress reaches the extension', () => {
  const live = new CaptureLive()
  const web = peer()
  const extension = peer()
  const webId = live.attach(web.socket)
  const extensionId = live.attach(extension.socket)
  live.receive(webId, JSON.stringify({ type: 'hello', role: 'web' }))
  live.receive(webId, JSON.stringify({ type: 'ready', ready: true }))
  live.receive(
    extensionId,
    JSON.stringify({ type: 'hello', role: 'extension' }),
  )

  live.receive(
    extensionId,
    JSON.stringify({
      type: 'capture',
      id: 'job-2',
      url: 'https://www.pixiv.net/artworks/42',
      mediaUrl: 'https://i.pximg.net/img-original/img/a.jpg',
    }),
  )
  assert.deepEqual(last(web.messages), {
    type: 'capture',
    id: 'job-2',
    url: 'https://www.pixiv.net/artworks/42',
    mediaUrl: 'https://i.pximg.net/img-original/img/a.jpg',
  })
  assert.equal(last(extension.messages).state, 'accepted')

  live.receive(
    webId,
    JSON.stringify({
      type: 'status',
      id: 'job-2',
      state: 'done',
      message: '已下载原图',
    }),
  )
  assert.deepEqual(last(extension.messages), {
    type: 'status',
    id: 'job-2',
    state: 'done',
    message: '已下载原图',
  })
  assert.equal(web.messages.filter((item) => isType(item, 'status')).length, 0)
})

test('the capture goes to the page that became ready most recently', () => {
  const live = new CaptureLive()
  const first = peer()
  const second = peer()
  const extension = peer()
  const firstId = live.attach(first.socket)
  const secondId = live.attach(second.socket)
  const extensionId = live.attach(extension.socket)
  for (const id of [firstId, secondId]) {
    live.receive(id, JSON.stringify({ type: 'hello', role: 'web' }))
    live.receive(id, JSON.stringify({ type: 'ready', ready: true }))
  }
  live.receive(
    extensionId,
    JSON.stringify({ type: 'hello', role: 'extension' }),
  )
  live.receive(
    extensionId,
    JSON.stringify({
      type: 'capture',
      id: 'job-3',
      url: 'https://www.pinterest.com/pin/1/',
    }),
  )
  assert.equal(
    first.messages.some((item) => isType(item, 'capture')),
    false,
  )
  assert.equal(last(second.messages).type, 'capture')
})

test('roles stay on their own side of the handshake', () => {
  const live = new CaptureLive()
  const web = peer()
  const extension = peer()
  const webId = live.attach(web.socket)
  const extensionId = live.attach(extension.socket)
  live.receive(webId, JSON.stringify({ type: 'hello', role: 'web' }))
  live.receive(
    extensionId,
    JSON.stringify({ type: 'hello', role: 'extension' }),
  )

  live.receive(extensionId, JSON.stringify({ type: 'ready', ready: true }))
  assert.equal(last(extension.messages).message, '只有采集页可以就绪')

  live.receive(
    webId,
    JSON.stringify({
      type: 'capture',
      id: 'job-4',
      url: 'https://www.pinterest.com/pin/1/',
    }),
  )
  assert.equal(last(web.messages).message, '只有插件可以发起采集')

  live.receive(webId, JSON.stringify({ type: 'ready', ready: true }))
  live.receive(
    extensionId,
    JSON.stringify({ type: 'status', id: 'job-4', state: 'done' }),
  )
  assert.equal(last(extension.messages).message, '只有采集页可以回报进度')
})

test('a peer must hello before anything else, and bad frames stay on that socket', () => {
  const live = new CaptureLive()
  const web = peer()
  const webId = live.attach(web.socket)
  live.receive(webId, JSON.stringify({ type: 'ready', ready: true }))
  assert.equal(last(web.messages).message, '先发送 hello')
  live.receive(webId, '{')
  assert.equal(last(web.messages).message, '消息不是 JSON')
  assert.equal(live.snapshot().webs, 0)
})

function isType(value: unknown, type: string): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === type
  )
}
