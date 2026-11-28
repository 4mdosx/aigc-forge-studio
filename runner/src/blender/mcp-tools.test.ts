import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { BlenderRuntime } from './runtime.ts'
import { createTools } from './mcp-tools.ts'

function runtime(codes: string[]): BlenderRuntime {
  return {
    dataDir: '/tmp',
    config: {
      dataDir: 'data/blender-plugin',
      command: 'uvx',
      args: [],
      env: {},
      timeout: 10,
    },
    callTool: async (name, args = {}) => {
      if (name === 'execute_blender_code') codes.push(String(args.code ?? ''))
      return { content: [{ type: 'text', text: 'ok' }], isError: false }
    },
    execute: async () => 'ok',
    status: async () => ({ connected: true, scenes: [], activeScene: null, filepath: '' }),
    close: async () => undefined,
  }
}

test('clear accepts a prefix', async () => {
  const codes: string[] = []
  await createTools(runtime(codes)).objects.clear('Panel_')
  assert.equal(codes.length, 1)
  assert.match(codes[0] ?? '', /prefix == '' or obj\.name\.startswith\(prefix\)/)
})

test('clear rejects empty prefix without explicit all', async () => {
  const codes: string[] = []
  const tools = createTools(runtime(codes))
  await assert.rejects(() => tools.objects.clear(), /拒绝空前缀/)
  await assert.rejects(() => tools.objects.clear(''), /拒绝空前缀/)
  assert.equal(codes.length, 0)
})

test('clear with all=true removes every object', async () => {
  const codes: string[] = []
  await createTools(runtime(codes)).objects.clear('', { all: true })
  assert.equal(codes.length, 1)
})

test('boxes and render pass values as base64 payloads', async () => {
  const codes: string[] = []
  const tools = createTools(runtime(codes))
  await tools.objects.boxes([
    { name: "P'1", location: [0, 0, 0], size: [1, 1, 1] },
  ])
  await tools.render.to('/tmp/a b.png', { resolutionX: 64, samples: 2 })
  assert.equal(codes.length, 2)
  assert.doesNotMatch(codes[0] ?? '', /P'1/)
  assert.match(codes[0] ?? '', /b64decode/)
  assert.match(codes[1] ?? '', /b64decode/)
})

test('call surfaces MCP errors', async () => {
  const fake = runtime([])
  fake.callTool = async () => ({
    content: [{ type: 'text', text: 'Error executing code: boom' }],
    isError: false,
  })
  await assert.rejects(() => createTools(fake).call('execute_blender_code'), /boom/)
})
