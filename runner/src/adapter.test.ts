import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { withApp } from './app.ts'
import { findAdapter, promptFromAdapter, runTask } from './adapter.ts'
import type { ComfyClient } from './comfy.ts'
import { findRepoRoot } from './config.ts'
import { RunnerError } from './errors.ts'
import { uiWorkflowToPrompt } from './ui-workflow.ts'

const root = findRepoRoot([import.meta.dirname])

test('sdxl adapter points text at the positive prompt node', () => {
  const adapter = findAdapter('text2img', 'sdxl')
  assert.equal(adapter.workflow, 'user/default/workflows/text2image_sdxl.json')
  const { prompt } = promptFromAdapter(root, adapter, { text: 'a tree' })
  assert.equal(prompt['10']?.inputs.text, 'a tree')
  assert.equal(prompt['10']?.class_type, 'CLIPTextEncode')
  assert.equal(
    prompt['15']?.inputs.ckpt_name,
    'animagine-xl-4.0-opt.safetensors',
  )
  assert.equal(prompt['16'], undefined)
  assert.deepEqual(prompt['12']?.inputs.model, ['15', 0])
  assert.equal(prompt['12']?.inputs.control_after_generate, undefined)
})

test('birefnet adapter uploads path onto LoadImage', () => {
  const adapter = findAdapter('remove-bg', 'birefnet')
  const prompt = uiWorkflowToPrompt(join(root, adapter.workflow))
  assert.equal(prompt['3']?.inputs.background, 'Alpha')
  assert.equal(prompt['3']?.inputs.model, 'BiRefNet-general')
  assert.equal(prompt['4']?.inputs['format.bit_depth'], '8-bit')
  assert.equal(prompt['2']?.inputs.upload, undefined)
  assert.deepEqual(prompt['3']?.inputs.image, ['2', 0])
})

test('runTask rejects an unknown entry', async () => {
  await assert.rejects(
    () =>
      withApp(app(), () => runTask('text2img', 'missing', { text: 'a tree' })),
    (err: unknown) =>
      err instanceof RunnerError && /no text2img adapter/.test(err.message),
  )
})

function app() {
  return {
    root,
    client: {} as ComfyClient,
    timeoutMs: 1000,
    outDir: '/tmp/unused',
    signal: new AbortController().signal,
  }
}
