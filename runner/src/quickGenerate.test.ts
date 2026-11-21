import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loraOverride, quickPayload } from './quickGenerate.ts'
import type { AdapterMap } from './workflow/binding.ts'
import type { Prompt } from './workflow/graph.ts'

const api: Prompt = {
  '10': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'old positive' },
    _meta: { title: 'Positive Prompt' },
  },
  '11': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'old negative' },
    _meta: { title: 'Negative Prompt' },
  },
  '13': {
    class_type: 'EmptyLatentImage',
    inputs: { width: 768, height: 1024, batch_size: 4 },
    _meta: { title: 'Empty Latent' },
  },
  '12': { class_type: 'KSampler', inputs: { seed: 1, model: ['15', 0] } },
  '17': {
    class_type: 'LoraLoader',
    inputs: { lora_name: 'style.safetensors', strength_model: 0.8 },
    _meta: { title: 'LoRA' },
  },
}

const adapter: AdapterMap = {
  inputs: {
    positive: { class_type: 'CLIPTextEncode', name: 'Positive Prompt', input: 'text' },
    negative: { class_type: 'CLIPTextEncode', name: 'Negative Prompt', input: 'text' },
    width: { class_type: 'EmptyLatentImage', name: 'Empty Latent', input: 'width' },
    height: { class_type: 'EmptyLatentImage', name: 'Empty Latent', input: 'height' },
    batch: { class_type: 'EmptyLatentImage', name: 'Empty Latent', input: 'batch_size' },
    seed: { class_type: 'KSampler', input: 'seed' },
    lora_name: { class_type: 'LoraLoader', name: 'LoRA', input: 'lora_name' },
    lora_strength: { class_type: 'LoraLoader', name: 'LoRA', input: 'strength_model' },
  },
  outputs: {},
}

test('quick payload puts the settings positive in front of the typed prompt', () => {
  const payload = quickPayload(api, adapter, '1girl, solo', {
    workflowPositive: 'masterpiece, absurdres',
    workflowNegative: 'lowres, bad hands',
  })
  assert.equal(payload.positive, 'masterpiece, absurdres, 1girl, solo')
  assert.equal(payload.negative, 'lowres, bad hands')
  assert.equal(payload.width, 768)
  assert.equal(payload.height, 1024)
  assert.equal(payload.batch, 4)
  assert.equal(payload.seed, 'random')
  assert.equal(payload.lora_name, 'style.safetensors')
  assert.equal(payload.lora_strength, 0.8)
  assert.equal('model' in payload, false)
})

test('quick payload turns a mapped node value back into the map key', () => {
  const mappedApi: Prompt = {
    ...api,
    '1': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: 'animagine-xl-4.0-zero.safetensors' },
    },
  }
  const mapped: AdapterMap = {
    ...adapter,
    inputs: {
      ...adapter.inputs,
      model: {
        class_type: 'CheckpointLoaderSimple',
        input: 'ckpt_name',
        map: { pd: 'pdv10.safetensors', ax4z: 'animagine-xl-4.0-zero.safetensors' },
      },
    },
  }
  const payload = quickPayload(mappedApi, mapped, '1girl', {
    workflowPositive: '',
    workflowNegative: 'lowres',
  })
  assert.equal(payload.model, 'ax4z')
})

test('quick payload applies pose size only when the adapter has those inputs', () => {
  const payload = quickPayload(
    api,
    adapter,
    '1girl',
    { workflowPositive: 'masterpiece', workflowNegative: 'lowres' },
    { width: 1216, height: 832, pose_image: 'quick/pose/bone.png' },
  )
  assert.equal(payload.width, 1216)
  assert.equal(payload.height, 832)
  assert.equal('pose_image' in payload, false)
  assert.equal(payload.positive, 'masterpiece, 1girl')
})

test('lora override writes the filename onto a free lora_name input', () => {
  assert.deepEqual(loraOverride(adapter, 'new.safetensors'), { lora_name: 'new.safetensors' })
  const payload = quickPayload(
    api,
    adapter,
    '1girl',
    { workflowPositive: '', workflowNegative: 'lowres' },
    loraOverride(adapter, 'new.safetensors'),
  )
  assert.equal(payload.lora_name, 'new.safetensors')
})

test('lora override maps a filename back to the step key', () => {
  const mapped: AdapterMap = {
    inputs: {
      positive: { class_type: 'CLIPTextEncode', name: 'Positive', input: 'text' },
      negative: { class_type: 'CLIPTextEncode', name: 'Negative', input: 'text' },
      step: {
        class_type: 'LoraLoader',
        input: 'lora_name',
        map: { '1200': 'style.safetensors', '1800': 'other.safetensors' },
      },
    },
    outputs: {},
  }
  assert.deepEqual(loraOverride(mapped, 'style.safetensors'), { step: '1200' })
  assert.throws(() => loraOverride(mapped, 'missing.safetensors'), /not in step/)
})

test('quick payload refuses a linked input that has no literal value', () => {
  const linked: Prompt = {
    ...api,
    '13': {
      class_type: 'EmptyLatentImage',
      inputs: { width: ['9', 0], height: 1024, batch_size: 1 },
      _meta: { title: 'Empty Latent' },
    },
  }
  assert.throws(
    () =>
      quickPayload(linked, adapter, '1girl', {
        workflowPositive: '',
        workflowNegative: 'lowres',
      }),
    /cannot fill width/,
  )
})
