import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ComfyClient, HistoryEntry } from '../comfy/client.ts'
import { openDatabase } from '../db.ts'
import type { Runner } from '../task/queue.ts'
import type { Prompt } from '../workflow/graph.ts'
import { createApp } from '../http/app.ts'

// compose 三段模型集成测试：work + adapter(prompt 块) + checkpoint 元数据 fixture，
// 走 POST /tasks 全链路验证 payload 组装，再验证 /trace 溯源。

const graph = {
  nodes: [
    {
      id: 1,
      type: 'CheckpointLoaderSimple',
      title: 'Load Checkpoint',
      inputs: [{ name: 'ckpt_name', widget: { name: 'ckpt_name' } }],
      widgets_values_named: { ckpt_name: 'checkpoints/test-ckpt.safetensors' },
    },
    {
      id: 6,
      type: 'CLIPTextEncode',
      title: 'positive',
      inputs: [{ name: 'text', widget: { name: 'text' } }],
      widgets_values_named: { text: '' },
    },
    {
      id: 7,
      type: 'CLIPTextEncode',
      title: 'negative',
      inputs: [{ name: 'text', widget: { name: 'text' } }],
      widgets_values_named: { text: '' },
    },
    {
      id: 3,
      type: 'KSampler',
      inputs: [{ name: 'seed', widget: { name: 'seed' } }],
      widgets_values_named: { seed: 1 },
    },
    {
      id: 9,
      type: 'SaveImage',
      title: 'result',
      inputs: [{ name: 'filename_prefix', widget: { name: 'filename_prefix' } }],
      widgets_values_named: { filename_prefix: 'out' },
    },
  ],
  links: [],
}

const adapter = {
  inputs: {
    positive: { class_type: 'CLIPTextEncode', name: 'positive', input: 'text' },
    negative: { class_type: 'CLIPTextEncode', name: 'negative', input: 'text' },
    seed: { class_type: 'KSampler', input: 'seed' },
  },
  outputs: {
    images: { class_type: 'SaveImage', name: 'result' },
  },
  prompt: {
    compose: true,
    anchors: ['gold buttons'],
    negativeExtra: ['artist name'],
  },
}

function fixtureData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'compose-it-'))
  mkdirSync(join(dir, 'models', 'checkpoint'), { recursive: true })
  writeFileSync(
    join(dir, 'models', 'promptProfiles.json'),
    JSON.stringify({
      profiles: {
        'test-profile': {
          qualityPos: 'start',
          qualityStart: ['masterpiece', 'best quality'],
          stripForeign: ['high score'],
          negativeBase: ['lowres', 'watermark'],
        },
      },
    }),
  )
  writeFileSync(
    join(dir, 'models', 'checkpoint', 'test-ckpt.json'),
    JSON.stringify({ path: 'checkpoints/test-ckpt.safetensors', promptProfileId: 'test-profile' }),
  )
  return dir
}

function testRunner(clients: ComfyClient[], dataDir: string): Runner {
  return {
    db: openDatabase(':memory:'),
    clients,
    chat: null,
    dataDir,
    timeoutMs: 600_000,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    randomSeed: () => 42,
  }
}

function fakeClient(baseURL: string): ComfyClient {
  return {
    baseURL,
    workflows: async () => ['refine-c.json'],
    workflow: async () => graph,
    writeWorkflow: async () => undefined,
    submitPrompt: async () => 'job-1',
    promptHistory: async () => null,
    cancelJob: async () => true,
    uploadBytes: async () => undefined,
    viewFile: async () => ({ bytes: new Uint8Array(1), contentType: 'image/png' }),
  } as unknown as ComfyClient
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

test('POST /tasks 组装 rawPositive 并经 /trace 溯源', async () => {
  const dataDir = fixtureData()
  const runner = testRunner([fakeClient('http://gpu-a')], dataDir)
  const app = createApp(runner)

  await app.request('/works', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'refine-c',
      semantic: {
        inputs: {
          positive: { type: 'string' },
          negative: { type: 'string' },
          seed: { type: 'seed' },
        },
      },
    }),
  })
  await app.request('/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'refine-c', comfyPath: 'refine-c.json' }),
  })
  await app.request('/works/refine-c/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflowName: 'refine-c' }),
  })

  const committed = await json(
    await app.request('/workflows/refine-c/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'initial' }),
    }),
  ) as { version?: string }
  const version = committed.version
  assert.ok(version, 'commit must return version')

  // adapter 带 prompt 块：parseAdapter 必须保留 compose 配置
  const saved = await json(
    await app.request('/works/refine-c/workflows/adapter', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowName: 'refine-c', version, adapter }),
    }),
  )
  assert.ok(!('error' in saved), `adapter save failed: ${JSON.stringify(saved)}`)

  const created = await json(
    await app.request('/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'compose-it',
        workName: 'refine-c',
        workflowName: 'refine-c',
        version,
        payload: {
          rawPositive: 'takao, high score, lying down',
          rawNegative: 'blurry',
          seed: 42,
        },
      }),
    }),
  ) as { id?: string; error?: string }
  assert.ok(created.id, `task create failed: ${JSON.stringify(created)}`)

  const task = runner.db
    .prepare(`SELECT input_json FROM tasks WHERE id = ?`)
    .get(created.id) as { input_json: string }
  const input = JSON.parse(task.input_json) as Record<string, unknown>
  // 方言段(前置质量词) + 素材段(剥 high score) + 目的锚
  assert.equal(
    input.positive,
    'masterpiece, best quality, takao, lying down, gold buttons',
  )
  // 负面 = 基座 + 素材 + 目的附加
  assert.equal(input.negative, 'lowres, watermark, blurry, artist name')
  assert.equal(input.rawPositive, undefined)

  // /trace：给任务写个 output_path 再反查
  runner.db
    .prepare(`UPDATE tasks SET output_path = ? WHERE id = ?`)
    .run('output/2026-01-01/compose-it/out_00001_.png', created.id)
  const traced = await json(
    await app.request('/trace?path=output/2026-01-01/compose-it/out_00001_.png'),
  ) as {
    taskId?: string
    workName?: string
    payload?: Record<string, unknown>
    error?: string
  }
  assert.equal(traced.taskId, created.id)
  assert.equal(traced.workName, 'refine-c')
  // 溯源返回的是产图时的最终 positive（即组装值，可作下一跳素材段）
  assert.match((traced.payload?.positive as string) ?? '', /^masterpiece, best quality/)

  // 未产出的路径 404
  const missing = await app.request('/trace?path=output/none.png')
  assert.equal(missing.status, 404)
})
