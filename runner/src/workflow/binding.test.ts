import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RunnerError } from '../errors.ts'
import { relativePath } from '../path.ts'
import { applyAdapter, parseAdapter, suggestAdapter } from './binding.ts'
import type { Prompt } from './graph.ts'

const prompt: Prompt = {
  '6': {
    class_type: 'CLIPTextEncode',
    inputs: { text: '' },
    _meta: { title: 'positive' },
  },
  '7': {
    class_type: 'CLIPTextEncode',
    inputs: { text: '' },
    _meta: { title: 'negative' },
  },
  '3': { class_type: 'KSampler', inputs: { seed: 1 } },
}

test('same class_type nodes are locked by title, and seed can be random or fixed', () => {
  const adapter = parseAdapter({
    inputs: {
      text: { class_type: 'CLIPTextEncode', name: 'positive', input: 'text' },
      seed: { class_type: 'KSampler', input: 'seed' },
    },
  })
  const random = applyAdapter(prompt, adapter, { text: 'hello' }, () => 99)
  assert.equal(random.prompt['6']?.inputs.text, 'hello')
  assert.equal(random.prompt['3']?.inputs.seed, 99)
  assert.equal(random.input.seed, 99)

  const fixed = applyAdapter(
    prompt,
    adapter,
    { text: 'hello', seed: 5 },
    () => 1,
  )
  assert.equal(fixed.prompt['3']?.inputs.seed, 5)

  assert.throws(
    () =>
      applyAdapter(
        prompt,
        parseAdapter({
          inputs: { text: { class_type: 'CLIPTextEncode', input: 'text' } },
        }),
        { text: 'hello' },
        () => 1,
      ),
    RunnerError,
  )
})

test('a unique positive prompt, sampler, and save node become the suggested adapter', () => {
  const suggested = suggestAdapter({
    ...prompt,
    '9': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
  })
  assert.deepEqual(suggested, {
    inputs: {
      text: {
        class_type: 'CLIPTextEncode',
        name: 'positive',
        input: 'text',
      },
      seed: { class_type: 'KSampler', input: 'seed' },
    },
    outputs: { images: { class_type: 'SaveImage' } },
  })
})

test('an upload workflow suggests the image path and the advanced save node', () => {
  const suggested = suggestAdapter({
    '2': { class_type: 'LoadImage', inputs: { image: 'a.png' } },
    '4': { class_type: 'SaveImageAdvanced', inputs: { images: ['2', 0] } },
  })
  assert.deepEqual(suggested, {
    inputs: {
      path: { class_type: 'LoadImage', input: 'image', upload: true },
    },
    outputs: { images: { class_type: 'SaveImageAdvanced' } },
  })
})

test('ambiguous nodes are left out of the suggestion', () => {
  assert.equal(
    suggestAdapter({
      '6': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
      '3': { class_type: 'KSampler', inputs: { seed: 1 } },
      '4': { class_type: 'KSampler', inputs: { seed: 1 } },
    }),
    null,
  )
})

test('relative paths reject escape', () => {
  assert.equal(relativePath('jobs/face.png'), 'jobs/face.png')
  assert.throws(() => relativePath('../face.png'), /invalid path/)
  assert.throws(() => relativePath('jobs/%2e%2e/face.png'), /invalid path/)
  assert.throws(() => relativePath('/jobs/face.png'), /invalid path/)
})

test('binding map maps values and rejects misses', () => {
  const prompt = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'pdv10.safetensors' } },
    '2': { class_type: 'LoraLoader', inputs: { lora_name: 'style-v1-formal-000002.safetensors', strength_model: 1.0, strength_clip: 1.0, model: ['1', 0], clip: ['1', 1] } },
    '3': { class_type: 'KSampler', inputs: { seed: 1, model: ['2', 0], positive: 0, negative: 0, latent_image: 0, steps: 30, cfg: 5, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1 } },
  }
  const adapter = parseAdapter({
    inputs: {
      step: {
        class_type: 'LoraLoader',
        input: 'lora_name',
        map: {
          '600': 'style-v1-formal-000001.safetensors',
          '1200': 'style-v1-formal-000002.safetensors',
          '1800': 'style-v1-formal.safetensors',
        },
      },
      seed: { class_type: 'KSampler', input: 'seed' },
    },
    outputs: {},
  })
  // number 1200 → String 命中 map
  const r1 = applyAdapter(prompt, adapter, { step: 1200, seed: 7 }, () => 0)
  assert.equal(r1.prompt['2'].inputs.lora_name, 'style-v1-formal-000002.safetensors')
  assert.equal(r1.input.step, 1200) // input 记原始值（重放幂等）
  // 字符串档位
  const r2 = applyAdapter(prompt, adapter, { step: '600', seed: 7 }, () => 0)
  assert.equal(r2.prompt['2'].inputs.lora_name, 'style-v1-formal-000001.safetensors')
  // 未命中 → 报错且列出合法值
  assert.throws(
    () => applyAdapter(prompt, adapter, { step: '900', seed: 7 }, () => 0),
    /not in map \(600\/1200\/1800\)/,
  )
  // 缺 step → missing
  assert.throws(() => applyAdapter(prompt, adapter, { seed: 7 }, () => 0), /missing input step/)
})

test('binding map must be a string-to-string record', () => {
  assert.throws(
    () => parseAdapter({ inputs: { step: { class_type: 'LoraLoader', input: 'lora_name', map: { a: 1 } } }, outputs: {} }),
    /map must be a string-to-string record/,
  )
})
