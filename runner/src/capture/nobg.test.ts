import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RunnerError } from '../errors.ts'
import type { Prompt } from '../workflow/graph.ts'
import { cutoutPrompt } from './nobg.ts'

const graph: Prompt = {
  '2': {
    class_type: 'LoadImage',
    inputs: { image: 'old.png' },
  },
  '3': {
    class_type: 'BiRefNetRMBG',
    inputs: { image: ['2', 0], background: 'Alpha' },
  },
  '4': {
    class_type: 'SaveImageAdvanced',
    inputs: { images: ['3', 0], filename_prefix: 'ComfyUI' },
  },
}

test('cutout prompt points LoadImage at the uploaded file', () => {
  const prompt = cutoutPrompt(graph, 'capture/abc/source.png', 'capture-nobg/asset-1')
  assert.equal(prompt['2']?.inputs.image, 'capture/abc/source.png')
  assert.equal(prompt['4']?.inputs.filename_prefix, 'capture-nobg/asset-1')
  assert.equal(graph['2']?.inputs.image, 'old.png')
  assert.equal(prompt['3']?.inputs.background, 'Alpha')
})

test('cutout prompt rejects a graph without one loader and one save', () => {
  const extra: Prompt = {
    ...graph,
    '5': { class_type: 'LoadImage', inputs: { image: 'b.png' } },
  }
  assert.throws(() => cutoutPrompt(extra, 'a.png', 'p'), RunnerError)
})
