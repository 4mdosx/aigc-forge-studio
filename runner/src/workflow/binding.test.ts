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
