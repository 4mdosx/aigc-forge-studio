import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { App } from './app.ts'
import type { ComfyClient } from './comfy.ts'
import { findRepoRoot } from './config.ts'
import { createServer } from './server.ts'
import type { Prompt } from './workflow.ts'

const root = findRepoRoot([import.meta.dirname])

test('http routes take business fields and use the app config', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'aigc-runner-'))
  const runs: Array<{ outDir: string; timeoutMs: number }> = []
  const client = {
    upload: async (file: string) => file,
    run: async (_prompt: Prompt, dir: string, timeoutMs: number) => {
      runs.push({ outDir: dir, timeoutMs })
      await mkdir(dir, { recursive: true })
      const file = join(dir, 'out.png')
      await writeFile(file, Buffer.from('png'))
      return { promptId: 'p1', files: [file] }
    },
  } as ComfyClient
  const app: App = {
    root,
    client,
    timeoutMs: 1234,
    outDir,
    signal: new AbortController().signal,
  }
  const server = createServer(app)
  const base = await listen(server)
  try {
    const missing = await post(base, '/text2img', { entry: 'sdxl' })
    assert.equal(missing.status, 400)
    assert.match(missing.body.error, /text is required/)

    const foreign = await post(base, '/text2img', {
      text: 'a tree',
      entry: 'sdxl',
      outDir: '/tmp/nope',
      timeoutMs: 1,
    })
    assert.equal(foreign.status, 400)
    assert.match(foreign.body.error, /unknown field/)

    const generated = await post(base, '/text2img', {
      text: 'a tree',
      entry: 'sdxl',
    })
    assert.equal(generated.status, 200)
    assert.equal(runs[0]?.timeoutMs, 1234)
    assert.equal(generated.body.path?.startsWith(outDir), true)
    assert.match(generated.body.path ?? '', /text2img-/)

    const cutout = await post(base, '/cutout', { text: 'a tree' })
    assert.equal(cutout.status, 200)
    assert.match(cutout.body.path ?? '', /remove-bg-/)
    assert.equal(runs.length, 3)
    assert.equal(runs.every((run) => run.timeoutMs === 1234), true)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }
})

test('GET /workflows/:name returns one ComfyUI workflow', async () => {
  const graph = { nodes: [{ id: 1 }], links: [] }
  const client = {
    workflow: async (name: string) => {
      assert.equal(name, 'nested/cutout.json')
      return graph
    },
  } as ComfyClient
  const app: App = {
    root,
    client,
    timeoutMs: 1234,
    outDir: root,
    signal: new AbortController().signal,
  }
  const server = createServer(app)
  const base = await listen(server)
  try {
    const one = await get(base, '/workflows/nested/cutout.json')
    assert.equal(one.status, 200)
    assert.equal(one.body.name, 'nested/cutout.json')
    assert.deepEqual(one.body.workflow, graph)

    const bad = await get(base, '/workflows/notes.txt')
    assert.equal(bad.status, 400)
    assert.match(bad.body.error ?? '', /must end with \.json/)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }
})

test('GET /workflows returns the list from ComfyUI', async () => {
  const client = {
    workflows: async () => ['text2image_sdxl.json', 'RM_BG.json'],
  } as ComfyClient
  const app: App = {
    root,
    client,
    timeoutMs: 1234,
    outDir: root,
    signal: new AbortController().signal,
  }
  const server = createServer(app)
  const base = await listen(server)
  try {
    const listed = await get(base, '/workflows')
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.workflows, ['text2image_sdxl.json', 'RM_BG.json'])

    const rejected = await post(base, '/workflows', {})
    assert.equal(rejected.status, 404)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }
})

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

async function post(
  base: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Reply }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Reply }
}

async function get(base: string, path: string): Promise<{ status: number; body: Reply }> {
  const res = await fetch(`${base}${path}`)
  return { status: res.status, body: (await res.json()) as Reply }
}

interface Reply {
  path?: string
  error?: string
  workflows?: string[]
  name?: string
  workflow?: unknown
}
