import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PNG } from 'pngjs'

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
    }),
  })
  assert.equal(created.status, 201)
  await attach(app, 'character-generator')

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
      task: 'text2img',
      workName: 'picture',
      workflowName: 'character-generator',
      payload: { text: 'a knight', seed: 'random' },
    }),
  })
  assert.equal(task.status, 201)
  const queued = (await task.json()) as {
    id: string
    status: string
    headRevisionId: string
    workName: string
    comfyPath: string
    version: string
  }
  assert.equal(queued.status, 'pending')
  assert.equal(queued.workName, 'picture')
  assert.equal(queued.comfyPath, 'character-generator.json')
  assert.match(queued.version, versionId)
  const active = (await (await app.request('/tasks')).json()) as {
    tasks: Array<{ id: string }>
  }
  assert.equal(
    active.tasks.some((item) => item.id === queued.id),
    true,
  )

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
  const finished = (await (await app.request('/tasks')).json()) as {
    tasks: Array<{ id: string }>
  }
  assert.equal(
    finished.tasks.some((item) => item.id === queued.id),
    false,
  )
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
    }),
  })
  await attach(app, 'character-generator')
  for (const text of ['one', 'two']) {
    await app.request('/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'text2img',
        workName: 'picture',
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
    created: Array<{ name: string; version: string }>
    unchanged: string[]
  }
  assert.deepEqual(
    result.created.map((item) => item.name),
    ['RM_BG'],
  )
  assert.match(result.created[0]?.version ?? '', versionId)
  assert.deepEqual(result.unchanged, [])
  const shown = (await (
    await app.request(
      `/workflows/RM_BG/revisions/${result.created[0]?.version}`,
    )
  ).json()) as {
    workflow: typeof graph
    nodes: Array<{ id: number; type: string }>
  }
  assert.deepEqual(shown.workflow, graph)
  assert.equal(
    shown.nodes.find((node) => node.id === 6)?.type,
    'CLIPTextEncode',
  )
  const noted = await app.request(
    `/workflows/RM_BG/revisions/${result.created[0]?.version}/message`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '去背景' }),
    },
  )
  assert.equal(noted.status, 200)

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
  assert.match(blocked.failed[0]?.error ?? '', /请使用覆盖/)
  const revised = (await (
    await app.request('/comfy/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'update', paths: ['RM_BG.json'] }),
    })
  ).json()) as { updated: Array<{ name: string; version: string }> }
  assert.equal(revised.updated[0]?.name, 'RM_BG')
  assert.equal(revised.updated[0]?.version, result.created[0]?.version)
  const history = (await (
    await app.request('/workflows/RM_BG/revisions')
  ).json()) as { revisions: Array<{ version: string; message: string | null }> }
  assert.equal(history.revisions.length, 1)
  assert.equal(history.revisions[0]?.message, '去背景')
  const covered = (await (await app.request('/comfy/workflows')).json()) as {
    workflows: Array<{ path: string; status: string }>
  }
  assert.equal(
    covered.workflows.find((item) => item.path === 'RM_BG.json')?.status,
    'unchanged',
  )

  const library = (await (await app.request('/workflows')).json()) as {
    workflows: Array<{ name: string; comfyPath: string; currentBranch: string }>
  }
  assert.equal(library.workflows.length, 1)
  assert.equal(library.workflows[0]?.name, 'RM_BG')
  assert.equal(library.workflows[0]?.comfyPath, 'RM_BG.json')
  assert.equal(library.workflows[0]?.currentBranch, 'main')
})

test('a task uses main when version is omitted, even after another branch moves', async () => {
  const runner = testRunner([fakeClient('http://gpu-a', [], () => null)])
  const app = createApp(runner)
  await app.request('/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'character-generator',
      comfyPath: 'character-generator.json',
    }),
  })
  const mainVersion = await attach(app, 'character-generator')
  await app.request('/workflows/character-generator/branches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'lora-a' }),
  })
  await app.request('/workflows/character-generator/switch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ branch: 'lora-a' }),
  })
  const committed = await app.request('/workflows/character-generator/commit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'branch only' }),
  })
  assert.equal(committed.status, 201)
  const branchVersion = ((await committed.json()) as { version: string })
    .version
  assert.match(branchVersion, versionId)
  assert.notEqual(branchVersion, mainVersion)
  const onMain = (await (
    await app.request('/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'text2img',
        workName: 'picture',
        workflowName: 'character-generator',
        payload: { text: 'a knight', seed: 1 },
      }),
    })
  ).json()) as { version: string }
  const onBranch = (await (
    await app.request('/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'text2img',
        workName: 'picture',
        workflowName: 'character-generator',
        version: branchVersion,
        payload: { text: 'a knight', seed: 1 },
      }),
    })
  ).json()) as { version: string }
  assert.equal(onMain.version, mainVersion)
  assert.equal(onBranch.version, branchVersion)

  const linked = (await (await app.request('/works/picture')).json()) as {
    workflows: Array<{
      versions: Array<{
        version: string
        borrowedFrom: string | null
        adapterStatus: { status: string }
      }>
    }>
  }
  assert.equal(linked.workflows.length, 1)
  const versions = linked.workflows[0]?.versions ?? []
  assert.equal(
    versions.find((item) => item.version === mainVersion)?.adapterStatus.status,
    'ready',
  )
  assert.equal(
    versions.find((item) => item.version === branchVersion)?.borrowedFrom,
    mainVersion,
  )

  const detached = await app.request('/works/picture/workflows/detach', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflowName: 'character-generator' }),
  })
  assert.equal(detached.status, 200)
  const work = (await (await app.request('/works/picture')).json()) as {
    workflows: unknown[]
  }
  assert.deepEqual(work.workflows, [])
})

const versionId = /^[0-9a-z]{8}$/

async function attach(
  app: ReturnType<typeof createApp>,
  workflowName: string,
  version?: string,
): Promise<string> {
  const existing = await app.request('/works/picture')
  if (existing.status === 404) {
    const created = await app.request('/works', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'picture',
        semantic: {
          inputs: {
            text: { type: 'string' },
            seed: { type: 'seed' },
          },
        },
      }),
    })
    assert.equal(created.status, 201)
  }
  const target =
    version ??
    (
      (await (
        await app.request(`/workflows/${workflowName}/revisions`)
      ).json()) as { revisions: Array<{ version: string; main?: boolean }> }
    ).revisions.find((item) => item.main)?.version
  if (!target) throw new Error('main version missing')
  const linked = await app.request('/works/picture/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflowName }),
  })
  if (linked.status !== 409) assert.equal(linked.status, 200)
  const saved = await app.request('/works/picture/workflows/adapter', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflowName, version: target, adapter }),
  })
  assert.equal(saved.status, 200)
  return target
}

function testRunner(clients: ComfyClient[]): Runner {
  return {
    db: openDatabase(':memory:'),
    clients,
    chat: null,
    dataDir: '/tmp/aigc-runner-test-data',
    timeoutMs: 600_000,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    randomSeed: () => 42,
  }
}

function tinyPng(): Uint8Array {
  // 4x4、16 个颜色各异的像素：deviation = 1 - 1/16 ≈ 0.94，远高于退化阈值 0.001
  const png = new PNG({ width: 4, height: 4 })
  for (let i = 0; i < 16; i += 1) {
    png.data[i * 4] = (i * 37) % 256
    png.data[i * 4 + 1] = (i * 61) % 256
    png.data[i * 4 + 2] = (i * 97) % 256
    png.data[i * 4 + 3] = 255
  }
  return new Uint8Array(PNG.sync.write(png))
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
      bytes: tinyPng(),
      contentType: 'image/png',
    }),
  } as unknown as ComfyClient
}
