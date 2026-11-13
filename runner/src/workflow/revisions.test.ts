import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ComfyClient } from '../comfy/client.ts'
import { openDatabase, revisionById } from '../db.ts'
import { applyAdapter, parseAdapter } from './binding.ts'
import type { Prompt } from './graph.ts'
import { readAndCreate } from './revisions.ts'

const sdxlGraph = {
  nodes: [
    {
      id: 10,
      type: 'CLIPTextEncode',
      title: 'positive',
      inputs: [{ name: 'text', widget: { name: 'text' } }],
      widgets_values_named: { text: '' },
    },
    {
      id: 15,
      type: 'CheckpointLoaderSimple',
      inputs: [{ name: 'ckpt_name', widget: { name: 'ckpt_name' } }],
      widgets_values_named: { ckpt_name: 'animagine-xl-4.0-opt.safetensors' },
    },
    { id: 16, type: 'Note', inputs: [], widgets_values_named: {} },
    {
      id: 12,
      type: 'KSampler',
      inputs: [{ name: 'model', link: 1 }],
      widgets_values_named: {},
    },
  ],
  links: [[1, 15, 0]],
}

const birefnetGraph = {
  nodes: [
    {
      id: 2,
      type: 'LoadImage',
      inputs: [
        { name: 'image', widget: { name: 'image' } },
        { name: 'upload', widget: { name: 'upload' } },
      ],
      widgets_values_named: { image: 'face.png', upload: 'image' },
    },
    {
      id: 3,
      type: 'RMBG',
      title: 'cutout',
      inputs: [
        { name: 'image', link: 1 },
        { name: 'background', widget: { name: 'background' } },
        { name: 'model', widget: { name: 'model' } },
      ],
      widgets_values_named: { background: 'Alpha', model: 'BiRefNet-general' },
    },
    {
      id: 4,
      type: 'SaveImage',
      inputs: [
        { name: 'format.bit_depth', widget: { name: 'format.bit_depth' } },
      ],
      widgets_values_named: { 'format.bit_depth': '8-bit' },
    },
  ],
  links: [[1, 2, 0]],
}

test('sdxl adapter points text at the positive prompt node', async () => {
  const { prompt, seen } = await storedPrompt(
    'text2image_sdxl.json',
    sdxlGraph,
    {
      inputs: {
        text: { class_type: 'CLIPTextEncode', name: 'positive', input: 'text' },
      },
      outputs: { images: { class_type: 'CheckpointLoaderSimple' } },
    },
  )
  const applied = applyAdapter(
    prompt,
    parseAdapter({
      inputs: {
        text: { class_type: 'CLIPTextEncode', name: 'positive', input: 'text' },
      },
    }),
    { text: 'a tree' },
    () => 1,
  )
  assert.equal(
    seen,
    'http://127.0.0.1:8188/userdata/workflows%2Ftext2image_sdxl.json',
  )
  assert.equal(applied.prompt['10']?.inputs.text, 'a tree')
  assert.equal(applied.prompt['10']?.class_type, 'CLIPTextEncode')
  assert.equal(
    prompt['15']?.inputs.ckpt_name,
    'animagine-xl-4.0-opt.safetensors',
  )
  assert.equal(prompt['16'], undefined)
  assert.deepEqual(prompt['12']?.inputs.model, ['15', 0])
  assert.equal(prompt['12']?.inputs.control_after_generate, undefined)
})

test('birefnet adapter uploads path onto LoadImage', async () => {
  const { prompt, seen } = await storedPrompt('RM_BG.json', birefnetGraph, {
    inputs: {
      path: { class_type: 'LoadImage', input: 'image', upload: true },
    },
  })
  const applied = applyAdapter(
    prompt,
    parseAdapter({
      inputs: {
        path: { class_type: 'LoadImage', input: 'image', upload: true },
      },
    }),
    { path: 'jobs/face.png' },
    () => 1,
  )
  assert.equal(seen, 'http://127.0.0.1:8188/userdata/workflows%2FRM_BG.json')
  assert.equal(prompt['3']?.inputs.background, 'Alpha')
  assert.equal(prompt['3']?.inputs.model, 'BiRefNet-general')
  assert.equal(prompt['4']?.inputs['format.bit_depth'], '8-bit')
  assert.equal(prompt['2']?.inputs.upload, undefined)
  assert.deepEqual(prompt['3']?.inputs.image, ['2', 0])
  assert.equal(applied.prompt['2']?.inputs.image, 'jobs/face.png')
})

async function storedPrompt(
  name: string,
  graph: unknown,
  adapter: unknown,
): Promise<{ prompt: Prompt; seen: string }> {
  let seen = ''
  const fetchImpl: typeof fetch = async (input) => {
    seen =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    return Response.json(graph)
  }
  const client = new ComfyClient('http://127.0.0.1:8188', { fetch: fetchImpl })
  const db = openDatabase(':memory:')
  const created = await readAndCreate(
    db,
    client,
    { name: name.replace(/\.json$/i, ''), comfyPath: name, adapter },
    new Date('2026-01-01T00:00:00.000Z'),
  )
  const stored = revisionById(db, created.revision.id)
  return { prompt: JSON.parse(stored.api_json) as Prompt, seen }
}
