import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ComfyClient,
  assertSuccess,
  filesFromHistory,
  loraNamesFrom,
  pollUntilDone,
  type HistoryEntry,
} from './client.ts'
import { RunnerError } from '../errors.ts'
import type { Prompt } from '../workflow/graph.ts'

const prompt: Prompt = {
  '9': {
    class_type: 'SaveImage',
    inputs: { filename_prefix: 'txt2img', images: ['8', 0] },
  },
}

test('submits a prompt and reads the image back through ComfyUI', async () => {
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
  })
  assert.equal(await client.submitPrompt(prompt), 'job-1')
  const entry = await client.promptHistory('job-1')
  const file = filesFromHistory(entry ?? {})[0]
  assert.equal(file?.filename, 'txt2img_00001_.png')
  const viewed = await client.viewFile('output', '', 'txt2img_00001_.png')
  assert.deepEqual(viewed.bytes, Uint8Array.from([9, 8, 7]))
  assert.equal(
    (bodies[0] as { prompt: Prompt }).prompt['9']?.class_type,
    'SaveImage',
  )
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

test('collects image files from history once', () => {
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
  assert.equal(files[0]?.subfolder, 'a')
  assert.equal(files[0]?.filename, 'cutout_00001_.png')
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
    seen =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    return Response.json({ nodes: [{ id: 2 }], links: [] })
  }
  const client = new ComfyClient('http://127.0.0.1:8188', { fetch: fetchImpl })
  assert.deepEqual(await client.workflow('nested/cutout.json'), {
    nodes: [{ id: 2 }],
    links: [],
  })
  assert.equal(
    seen,
    'http://127.0.0.1:8188/userdata/workflows%2Fnested%2Fcutout.json',
  )
  await assert.rejects(
    () => client.workflow('../secret.json'),
    /invalid workflow name/,
  )
  await assert.rejects(
    () => client.workflow('notes.txt'),
    /must end with \.json/,
  )
})

test('lists input and output files from ComfyUI', async () => {
  let seen = ''
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    )
    seen = url.pathname
    return Response.json(['jobs/face.png [input]', 'example.png [input]'])
  }
  const client = new ComfyClient('http://127.0.0.1:8188', { fetch: fetchImpl })
  assert.deepEqual(await client.listFiles('input'), [
    'jobs/face.png',
    'example.png',
  ])
  assert.equal(seen, '/internal/files/input')
  await assert.rejects(
    () =>
      new ComfyClient('http://127.0.0.1:8188', {
        fetch: async () => Response.json(['../secret.png [input]']),
      }).listFiles('input'),
    /invalid path/,
  )
})

test('upload sends bytes to the ComfyUI input directory', async () => {
  let seen = ''
  const fetchImpl: typeof fetch = async (input) => {
    seen =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    return Response.json({ name: 'face.png', subfolder: 'jobs', type: 'input' })
  }
  const client = new ComfyClient('http://127.0.0.1:8188', { fetch: fetchImpl })
  await client.uploadBytes(Uint8Array.from([1, 2, 3]), 'face.png', 'jobs')
  assert.equal(seen, 'http://127.0.0.1:8188/upload/image')
})

test('lora names come from the LoraLoader combo list', () => {
  assert.deepEqual(
    loraNamesFrom({
      LoraLoader: {
        input: { required: { lora_name: [['None', 'style.safetensors']] } },
      },
    }),
    ['None', 'style.safetensors'],
  )
})
