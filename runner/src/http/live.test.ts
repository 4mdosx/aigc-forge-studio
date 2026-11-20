import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { WebSocketServer } from 'ws'

import { CaptureLive } from '../capture/live.ts'
import { mountCaptureLive } from './live.ts'

test('web and extension exchange capture over the websocket', async () => {
  const live = new CaptureLive()
  const app = new Hono()
  mountCaptureLive(app, live)
  const sockets = new WebSocketServer({ noServer: true })
  const server = serve({
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: 0,
    websocket: { server: sockets },
  })
  const clients: LiveClient[] = []
  try {
    await once(server, 'listening')
    const address = server.address() as AddressInfo
    const url = `ws://127.0.0.1:${address.port}/capture/live`
    const web = await openLive(url)
    const extension = await openLive(url)
    clients.push(web, extension)

    web.send({ type: 'hello', role: 'web' })
    assert.equal((await web.next()).webReady, false)
    web.send({ type: 'ready', ready: true })
    assert.equal((await web.next()).webReady, true)

    extension.send({ type: 'hello', role: 'extension' })
    const joined = await extension.next()
    assert.equal(joined.webReady, true)
    assert.equal(joined.extensions, 1)
    assert.equal((await web.next()).extensions, 1)

    extension.send({
      type: 'capture',
      id: 'job-ws',
      url: 'https://www.pixiv.net/artworks/7',
      mediaUrl: 'https://i.pximg.net/img-original/img/a.jpg',
    })
    const job = await web.next()
    assert.equal(job.type, 'capture')
    assert.equal(job.id, 'job-ws')
    assert.equal(job.mediaUrl, 'https://i.pximg.net/img-original/img/a.jpg')
    assert.equal((await extension.next()).state, 'accepted')

    web.send({
      type: 'status',
      id: 'job-ws',
      state: 'done',
      message: '已下载原图',
    })
    const done = await extension.next()
    assert.equal(done.state, 'done')
    assert.equal(done.message, '已下载原图')

    web.send({ type: 'ready', ready: false })
    assert.equal((await extension.next()).webReady, false)
    extension.send({
      type: 'capture',
      id: 'job-late',
      url: 'https://www.pinterest.com/pin/1/',
    })
    assert.equal((await extension.next()).state, 'rejected')
  } finally {
    for (const client of clients) client.close()
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }
})

type LiveMessage = Record<string, unknown>

type LiveClient = {
  send: (body: unknown) => void
  next: () => Promise<LiveMessage>
  close: () => void
}

function openLive(url: string): Promise<LiveClient> {
  const ws = new WebSocket(url)
  const queue: LiveMessage[] = []
  const waiters: Array<(message: LiveMessage) => void> = []
  ws.addEventListener('message', (event) => {
    void textOf(event.data).then((text) => {
      const message = JSON.parse(text) as LiveMessage
      const waiter = waiters.shift()
      if (waiter) waiter(message)
      else queue.push(message)
    })
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('websocket open timeout')),
      2000,
    )
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve({
        send(body) {
          ws.send(JSON.stringify(body))
        },
        next() {
          const existing = queue.shift()
          if (existing) return Promise.resolve(existing)
          return new Promise((done, reject) => {
            const timer = setTimeout(
              () => reject(new Error('websocket message timeout')),
              2000,
            )
            waiters.push((message) => {
              clearTimeout(timer)
              done(message)
            })
          })
        },
        close() {
          ws.close()
        },
      })
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('websocket failed'))
    })
  })
}

async function textOf(data: unknown): Promise<string> {
  if (typeof data === 'string') return data
  if (data instanceof Blob) return data.text()
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return String(data)
}
