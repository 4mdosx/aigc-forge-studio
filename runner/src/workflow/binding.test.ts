import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RunnerError } from '../errors.ts'
import { relativePath } from '../path.ts'
import { applyAdapter, parseAdapter } from './binding.ts'
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

test('relative paths reject escape', () => {
  assert.equal(relativePath('jobs/face.png'), 'jobs/face.png')
  assert.throws(() => relativePath('../face.png'), /invalid path/)
  assert.throws(() => relativePath('jobs/%2e%2e/face.png'), /invalid path/)
  assert.throws(() => relativePath('/jobs/face.png'), /invalid path/)
})
