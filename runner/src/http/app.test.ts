import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ComfyClient, HistoryEntry } from '../comfy/client.ts'
import { openDatabase } from '../db.ts'
import { tick, type Runner } from '../task/queue.ts'
import type { Prompt } from '../workflow/graph.ts'
import { createApp } from './app.ts'

const graph = {
  nodes: [
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
      inputs: [
        { name: 'filename_prefix', widget: { name: 'filename_prefix' } },
      ],
      widgets_values_named: { filename_prefix: 'out' },
    },
  ],
  links: [],
}

const adapter = {
  inputs: {
    text: { class_type: 'CLIPTextEncode', name: 'positive', input: 'text' },
    seed: { class_type: 'KSampler', input: 'seed' },
  },
  outputs: {
    images: { class_type: 'SaveImage', name: 'result' },
  },
}

test('commit, queue one task per instance, and record paths', async () => {
  const submitted: Prompt[] = []
  let history: HistoryEntry | null = null
  const client = fakeClient('http://gpu-a', submitted, () => history)
  const runner = testRunner([client])
  const app = createApp(runner)

  const created = await app.request('/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'character-generator',
      comfyPath: 'character-generator.json',
      adapter,
    }),
  })
  assert.equal(created.status, 201)

  const branched = await app.request(
    '/workflows/character-generator/branches',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'lora-a' }),
    },
  )
  assert.equal(branched.status, 201)

  const task = await app.request('/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      executor: 'comfyui',
      task: 'text2img',
      workflowName: 'character-generator',
      payload: { text: 'a knight', seed: 'random' },
    }),
  })
  assert.equal(task.status, 201)
  const queued = (await task.json()) as {
    id: string
    status: string
    headRevisionId: string
  }
  assert.equal(queued.status, 'pending')

  await tick(runner)
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0]?.['6']?.inputs.text, 'a knight')
  assert.equal(typeof submitted[0]?.['3']?.inputs.seed, 'number')

  history = {
    status: { status_str: 'success', completed: true },
    outputs: {
      '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
      '8': {
        images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }],
      },
    },
  }
  await tick(runner)
  const done = await app.request(`/tasks/${queued.id}`)
  const body = (await done.json()) as {
    status: string
    outputPath: string
    process: Array<{ path: string; name: string; id: string }>
  }
  assert.equal(body.status, 'completed')
  assert.equal(body.outputPath, 'output/a.png')
  assert.deepEqual(body.process, [
    { path: 'temp/preview.png', name: '', id: '8' },
  ])

  const listed = await app.request(`/revisions/${queued.headRevisionId}/tasks`)
  assert.equal(listed.status, 200)
  const files = await app.request(`/tasks/${queued.id}/files/output/a.png`)
  assert.equal(files.status, 200)
  const escaped = await app.request(
    `/tasks/${queued.id}/files/output/%2e%2e/secret.png`,
  )
  assert.equal(escaped.status, 400)
})

test('a second instance runs the next pending task', async () => {
  const first: Prompt[] = []
  const second: Prompt[] = []
  const runner = testRunner([
    fakeClient('http://gpu-a', first, () => null),
    fakeClient('http://gpu-b', second, () => null),
  ])
  const app = createApp(runner)
  await app.request('/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'character-generator',
      comfyPath: 'character-generator.json',
      adapter,
    }),
  })
  for (const text of ['one', 'two']) {
    await app.request('/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        executor: 'comfyui',
        task: 'text2img',
        workflowName: 'character-generator',
        payload: { text, seed: 7 },
      }),
    })
  }
  await tick(runner)
  assert.equal(first.length, 1)
  assert.equal(second.length, 1)
  assert.equal(first[0]?.['6']?.inputs.text, 'one')
  assert.equal(second[0]?.['6']?.inputs.text, 'two')
})

test('llm tasks use their own concurrency and do not submit to ComfyUI', async () => {
  const submitted: Prompt[] = []
  let calls = 0
  const runner = testRunner([fakeClient('http://gpu-a', submitted, () => null)])
  runner.llm = {
    baseURL: 'http://llm',
    model: 'writer',
    concurrency: 8,
    timeoutMs: 60_000,
  }
  runner.fetchImpl = async () => {
    calls += 1
    return Response.json({
      choices: [{ message: { content: 'a knight in red' } }],
    })
  }
  const app = createApp(runner)
  const created = await app.request('/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      executor: 'llm',
      task: 'prompt',
      payload: { prompt: 'describe a knight' },
    }),
  })
  const task = (await created.json()) as { id: string }
  await tick(runner)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const done = (await (await app.request(`/tasks/${task.id}`)).json()) as {
    status: string
    outputText: string
  }
  assert.equal(calls, 1)
  assert.equal(submitted.length, 0)
  assert.equal(done.status, 'completed')
  assert.equal(done.outputText, 'a knight in red')
})

test('imports a workflow chosen from the ComfyUI list', async () => {
  const client = fakeClient('http://gpu-a', [], () => null)
  client.workflows = async () => ['text2image_sdxl.json', 'RM_BG.json']
  const app = createApp(testRunner([client]))

  const listed = await app.request('/comfy/workflows')
  assert.equal(listed.status, 200)
  const catalog = (await listed.json()) as {
    workflows: Array<{ path: string; status: string }>
  }
  assert.deepEqual(
    catalog.workflows.map((item) => item.path),
    ['text2image_sdxl.json', 'RM_BG.json'],
  )
  assert.equal(
    catalog.workflows.every((item) => item.status === 'new'),
    true,
  )

  const imported = await app.request('/comfy/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'import', paths: ['RM_BG.json'] }),
  })
  assert.equal(imported.status, 200)
  const result = (await imported.json()) as {
    created: Array<{ name: string; version: number }>
    unchanged: string[]
  }
  assert.deepEqual(
    result.created.map((item) => item.name),
    ['RM_BG'],
  )
  assert.equal(result.created[0]?.version, 1)
  assert.deepEqual(result.unchanged, [])

  const same = (await (await app.request('/comfy/workflows')).json()) as {
    workflows: Array<{ path: string; status: string }>
  }
  assert.equal(
    same.workflows.find((item) => item.path === 'RM_BG.json')?.status,
    'unchanged',
  )

  const again = (await (
    await app.request('/comfy/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'import', paths: ['RM_BG.json'] }),
    })
  ).json()) as { unchanged: Array<{ name: string }>; updated: unknown[] }
  assert.equal(again.unchanged[0]?.name, 'RM_BG')
  assert.deepEqual(again.updated, [])

  client.workflow = async () => ({
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === 6
        ? { ...node, widgets_values_named: { text: 'edited' } }
        : node,
    ),
  })
  const changed = (await (await app.request('/comfy/workflows')).json()) as {
    workflows: Array<{ path: string; status: string }>
  }
  assert.equal(
    changed.workflows.find((item) => item.path === 'RM_BG.json')?.status,
    'updated',
  )
  const blocked = (await (
    await app.request('/comfy/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'import', paths: ['RM_BG.json'] }),
    })
  ).json()) as { updated: unknown[]; failed: Array<{ error: string }> }
  assert.deepEqual(blocked.updated, [])
  assert.match(blocked.failed[0]?.error ?? '', /请使用更新/)
  const revised = (await (
    await app.request('/comfy/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'update', paths: ['RM_BG.json'] }),
    })
  ).json()) as { updated: Array<{ name: string; version: number }> }
  assert.equal(revised.updated[0]?.name, 'RM_BG')
  assert.equal(revised.updated[0]?.version, 2)

  const library = (await (await app.request('/workflows')).json()) as {
    workflows: Array<{ name: string; comfyPath: string; currentBranch: string }>
  }
  assert.equal(library.workflows.length, 1)
  assert.equal(library.workflows[0]?.name, 'RM_BG')
  assert.equal(library.workflows[0]?.comfyPath, 'RM_BG.json')
  assert.equal(library.workflows[0]?.currentBranch, 'main')
})

function testRunner(clients: ComfyClient[]): Runner {
  return {
    db: openDatabase(':memory:'),
    clients,
    llm: null,
    timeoutMs: 600_000,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    randomSeed: () => 42,
    stops: new Map(),
  }
}

function fakeClient(
  baseURL: string,
  submitted: Prompt[],
  history: () => HistoryEntry | null,
): ComfyClient {
  return {
    baseURL,
    workflows: async () => ['character-generator.json'],
    workflow: async () => graph,
    writeWorkflow: async () => undefined,
    submitPrompt: async (prompt: Prompt) => {
      submitted.push(prompt)
      return `job-${submitted.length}`
    },
    promptHistory: async () => history(),
    cancelJob: async () => true,
    uploadBytes: async () => undefined,
    viewFile: async () => ({
      bytes: Uint8Array.from([1]),
      contentType: 'image/png',
    }),
  } as unknown as ComfyClient
}
