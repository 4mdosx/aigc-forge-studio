import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  ComfyClient,
  assertSuccess,
  filesFromHistory,
  outputPath,
  pollUntilDone,
  type HistoryEntry,
} from './comfy.ts'
import { RunnerError } from './errors.ts'
import type { Prompt } from './workflow.ts'

const prompt: Prompt = {
  '9': {
    class_type: 'SaveImage',
    inputs: { filename_prefix: 'txt2img', images: ['8', 0] },
  },
}

test('writes history images after the job appears', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aigc-comfy-'))
  let polls = 0
  const bodies: unknown[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    )
    if (url.pathname === '/prompt') {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ prompt_id: 'job-1', number: 1, node_errors: {} })
    }
    if (url.pathname === '/history/job-1') {
      polls += 1
      if (polls === 1) return Response.json({})
      const entry: HistoryEntry = {
        status: { status_str: 'success', completed: true, messages: [] },
        outputs: {
          '9': {
            images: [
              { filename: 'txt2img_00001_.png', subfolder: '', type: 'output' },
            ],
          },
        },
      }
      return Response.json({ 'job-1': entry })
    }
    if (url.pathname === '/view') {
      assert.equal(url.searchParams.get('filename'), 'txt2img_00001_.png')
      assert.equal(url.searchParams.get('type'), 'output')
      return new Response(new Uint8Array([9, 8, 7]))
    }
    return new Response('nope', { status: 404 })
  }

  const client = new ComfyClient('http://192.168.8.136:8188', {
    fetch: fetchImpl,
    sleep: async () => undefined,
    now: () => 0,
  })
  const result = await client.run(prompt, dir, 5_000)
  assert.equal(result.promptId, 'job-1')
  assert.deepEqual(
    await readFile(result.files[0] ?? ''),
    Buffer.from([9, 8, 7]),
  )
  assert.equal(
    (bodies[0] as { prompt: Prompt }).prompt['9']?.class_type,
    'SaveImage',
  )
})

test('timeout cancels the prompt', async () => {
  let cancelled = false
  let clock = 0
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    )
    if (url.pathname === '/prompt')
      return Response.json({ prompt_id: 'job-2', number: 0, node_errors: {} })
    if (url.pathname === '/history/job-2') return Response.json({})
    if (url.pathname === '/api/jobs/job-2/cancel' && init?.method === 'POST') {
      cancelled = true
      return Response.json({ cancelled: true })
    }
    return new Response('nope', { status: 404 })
  }
  const client = new ComfyClient('http://127.0.0.1:8188', {
    fetch: fetchImpl,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms
    },
  })
  await assert.rejects(
    () => client.run(prompt, '/tmp/unused', 1_500),
    /timed out after 1.5s/,
  )
  assert.equal(cancelled, true)
})

test('execution_error names the node', () => {
  const entry: HistoryEntry = {
    status: {
      status_str: 'error',
      messages: [
        [
          'execution_error',
          { node_type: 'KSampler', node_id: '12', exception_message: 'boom' },
        ],
      ],
    },
  }
  assert.throws(
    () => assertSuccess(entry),
    (err: unknown) =>
      err instanceof RunnerError && err.message === 'KSampler 12: boom',
  )
})

test('collects image files and refuses parent segments', () => {
  const files = filesFromHistory({
    outputs: {
      '4': {
        images: [
          { filename: 'cutout_00001_.png', subfolder: 'a', type: 'output' },
          { filename: 'cutout_00001_.png', subfolder: 'a', type: 'output' },
        ],
      },
    },
  })
  assert.equal(files.length, 1)
  assert.equal(
    outputPath('/out', 'a', 'cutout_00001_.png'),
    join('/out', 'a', 'cutout_00001_.png'),
  )
  assert.throws(() => outputPath('/out', '..', 'a.png'), /bad subfolder/)
})

test('pollUntilDone returns the first finished entry', async () => {
  let calls = 0
  const entry = await pollUntilDone({
    timeoutMs: 5_000,
    now: () => 0,
    sleep: async () => undefined,
    poll: async () => {
      calls += 1
      return calls < 2 ? null : { status: { status_str: 'success' } }
    },
  })
  assert.equal(entry.status?.status_str, 'success')
})

test('lists workflow json files from ComfyUI', async () => {
  let seen = ''
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    )
    seen = `${url.pathname}?${url.searchParams.toString()}`
    return Response.json([
      'nested/cutout.json',
      'notes.txt',
      'text2image_sdxl.json',
      'RM_BG.JSON',
    ])
  }
  const client = new ComfyClient('http://127.0.0.1:8188', { fetch: fetchImpl })
  assert.deepEqual(await client.workflows(), [
    'RM_BG.JSON',
    'nested/cutout.json',
    'text2image_sdxl.json',
  ])
  assert.equal(seen, '/userdata?dir=workflows&recurse=true')
})

test('reads one workflow json from ComfyUI', async () => {
  let seen = ''
  const fetchImpl: typeof fetch = async (input) => {
    seen = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return Response.json({ nodes: [{ id: 2 }], links: [] })
  }
  const client = new ComfyClient('http://127.0.0.1:8188', { fetch: fetchImpl })
  assert.deepEqual(await client.workflow('nested/cutout.json'), {
    nodes: [{ id: 2 }],
    links: [],
  })
  assert.equal(seen, 'http://127.0.0.1:8188/userdata/workflows%2Fnested%2Fcutout.json')
  await assert.rejects(() => client.workflow('../secret.json'), /invalid workflow name/)
  await assert.rejects(() => client.workflow('notes.txt'), /must end with \.json/)
})

test('upload keeps the server filename', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aigc-upload-'))
  const file = join(dir, 'face.png')
  await writeFile(file, 'png')
  const fetchImpl: typeof fetch = async () =>
    Response.json({ name: 'face.png', subfolder: 'pasted', type: 'input' })
  const client = new ComfyClient('http://127.0.0.1:8188', { fetch: fetchImpl })
  assert.equal(await client.upload(file), 'pasted/face.png')
})
