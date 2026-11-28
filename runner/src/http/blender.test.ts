import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'

import type { BlenderRuntime, BlenderStatus } from '../blender/runtime.ts'
import { RunnerError } from '../errors.ts'
import { mountBlender } from './blender.ts'

const SOURCE = `export async function run(ctx) {
  ctx.log('vars=' + JSON.stringify(ctx.vars))
  await ctx.mcp.objects.boxes([
    { name: 'Probe_1', location: [0, 0, 0], size: [1, 1, 1] }
  ])
}
`

interface ToolCall {
  name: string
  args: Record<string, unknown>
}

function fixture(): { dataDir: string; app: Hono; calls: ToolCall[] } {
  const dataDir = mkdtempSync(join(tmpdir(), 'aigc-blender-'))
  const plugin = join(dataDir, 'plugins', 'probe')
  mkdirSync(join(plugin, 'scripts'), { recursive: true })
  mkdirSync(join(dataDir, 'scenes'), { recursive: true })
  writeFileSync(
    join(plugin, 'manifest.json'),
    JSON.stringify({
      id: 'probe',
      name: 'Probe',
      description: 'test plugin',
      entry: 'scripts/main.ts',
      files: ['scripts/main.ts'],
      variables: {
        count: { type: 'number', label: 'Count', default: 2, min: 1, max: 5 },
        enabled: { type: 'boolean', default: true },
        label: { type: 'string', default: 'panel' },
      },
    }),
  )
  writeFileSync(join(plugin, 'scripts', 'main.ts'), SOURCE)
  writeFileSync(join(dataDir, 'scenes', 'template.blend'), 'stub')
  const calls: ToolCall[] = []
  const status: BlenderStatus = {
    connected: true,
    scenes: [
      { name: 'Scene', active: true, filepath: '' },
      { name: 'Alt', active: false, filepath: '' },
    ],
    activeScene: 'Scene',
    filepath: '',
  }
  const fake: BlenderRuntime = {
    dataDir,
    config: {
      dataDir: 'data/blender-plugin',
      command: 'uvx',
      args: [],
      env: {},
      timeout: 10,
    },
    callTool: async (name, args = {}) => {
      calls.push({ name, args })
      return {
        content: [{ type: 'text', text: 'Code executed successfully: done\n' }],
        isError: false,
      }
    },
    execute: async () => 'Code executed successfully: done\n',
    status: async () => status,
    close: async () => undefined,
  }
  const app = new Hono()
  app.onError((err, c) =>
    c.json(
      { error: err instanceof Error ? err.message : String(err) },
      (err instanceof RunnerError ? err.status : 500) as 400,
    ),
  )
  mountBlender(app, fake)
  return { dataDir, app, calls }
}

test('lists plugins and reads TypeScript source', async () => {
  const { app } = fixture()
  const listed = (await (await app.request('/blender/plugins')).json()) as {
    plugins: Array<{ id: string }>
  }
  assert.deepEqual(
    listed.plugins.map((item) => item.id),
    ['probe'],
  )
  const detail = (await (await app.request('/blender/plugins/probe')).json()) as {
    sources: Array<{ path: string; content: string }>
  }
  assert.equal(detail.sources[0]?.path, 'scripts/main.ts')
  assert.equal(detail.sources[0]?.content, SOURCE)
})

test('merges live scenes with .blend templates', async () => {
  const { app } = fixture()
  const body = (await (await app.request('/blender/scenes')).json()) as {
    scenes: Array<{ name: string }>
    templates: Array<{ name: string }>
  }
  assert.deepEqual(
    body.scenes.map((item) => item.name),
    ['Scene', 'Alt'],
  )
  assert.deepEqual(
    body.templates.map((item) => item.name),
    ['template'],
  )
})

test('runs a TypeScript plugin through MCP and records the run', async () => {
  const { app, calls, dataDir } = fixture()
  const response = await app.request('/blender/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pluginId: 'probe',
      scene: 'Alt',
      variables: { count: 4, label: 'wing' },
    }),
  })
  assert.equal(response.status, 200)
  const run = (await response.json()) as {
    id: string
    status: string
    variables: Record<string, unknown>
    log: string
  }
  assert.equal(run.status, 'ok')
  assert.deepEqual(run.variables, { count: 4, enabled: true, label: 'wing' })
  assert.match(run.log, /"count":4/)
  assert.ok(calls.some((item) => item.name === 'execute_blender_code'))
  assert.ok(
    calls.some((item) => /scene not found/.test(String(item.args.code))),
    'scene selection should go through MCP',
  )
  const stored = JSON.parse(
    readFileSync(join(dataDir, 'runs', run.id, 'run.json'), 'utf8'),
  ) as { status: string }
  assert.equal(stored.status, 'ok')
})

test('rejects variables outside schema bounds', async () => {
  const { app } = fixture()
  const response = await app.request('/blender/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pluginId: 'probe', variables: { count: 99 } }),
  })
  assert.equal(response.status, 400)
})

test('rejects plugin id path traversal', async () => {
  const { app } = fixture()
  const response = await app.request('/blender/plugins/..%2F..%2Fetc')
  assert.equal(response.status, 400)
})
