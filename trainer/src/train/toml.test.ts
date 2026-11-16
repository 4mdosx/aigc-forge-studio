import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildDatasetToml,
  buildTrainToml,
  jobPaths,
  resolveParams,
} from './toml.ts'

const params = resolveParams({
  name: 'style-v1',
  datasetRoot: 'training',
  datasetPath: 'style-v1/img',
  baseModel: 'checkpoints/pdv10.safetensors',
})

const paths = jobPaths(
  { training: 'C:\\AIGC\\training', models: 'C:\\AIGC\\models' },
  params,
)

// resolveParams 的输入基线（不带 samplePrompts，方便 spread 覆盖）
const base = {
  name: params.name,
  datasetRoot: params.datasetRoot,
  datasetPath: params.datasetPath,
  baseModel: params.baseModel,
}

test('resolveParams applies style-LoRA defaults', () => {
  assert.equal(params.resolution, 1024)
  assert.equal(params.batchSize, 1)
  assert.equal(params.numRepeats, 10)
  assert.equal(params.networkDim, 128)
  assert.equal(params.networkAlpha, 32)
  assert.equal(params.unetLr, 4e-4)
  assert.equal(params.textEncoderLr, 5e-5)
  assert.equal(params.scheduler, 'constant')
  assert.equal(params.clipSkip, 2)
  assert.equal(params.minSnrGamma, 5)
  assert.equal(params.sdpa, true)
  assert.equal(params.shuffleCaption, true)
  assert.equal(params.maxTrainEpochs, 10)
  assert.equal(params.samplePrompts, null)
})

test('resolveParams rejects bad name, traversal, unknown scheduler', () => {
  assert.throws(
    () => resolveParams({ ...base, name: '' } as never),
    /name must match/,
  )
  assert.throws(
    () => resolveParams({ ...base, datasetPath: '../escape' }),
    /invalid path/,
  )
  assert.throws(
    () =>
      resolveParams({
        ...base,
        scheduler: 'step' as never,
      }),
    /scheduler must be one of/,
  )
})

test('resolveParams rejects non-numeric overrides', () => {
  assert.throws(
    () => resolveParams({ ...base, resolution: 'big' as never }),
    /resolution must be a finite number/,
  )
  assert.throws(
    () => resolveParams({ ...base, resolution: 0 }),
    /must be > 0/,
  )
})

test('jobPaths resolves Windows-side layout', () => {
  assert.equal(paths.datasetDir, 'C:\\AIGC\\training\\style-v1\\img')
  assert.equal(
    paths.modelPath,
    'C:\\AIGC\\models\\checkpoints\\pdv10.safetensors',
  )
  assert.equal(paths.outputDir, 'C:\\AIGC\\training\\style-v1\\output')
  assert.equal(paths.configDir, 'C:\\AIGC\\training\\style-v1\\config')
})

test('buildDatasetToml emits general/datasets/subsets with literal paths', () => {
  const text = buildDatasetToml(params, paths)
  assert.match(text, /\[general\]/)
  assert.match(text, /shuffle_caption = true/)
  assert.match(text, /caption_extension = '\.txt'/)
  assert.match(text, /\[\[datasets\]\]/)
  assert.match(text, /resolution = 1024/)
  assert.match(text, /batch_size = 1/)
  assert.match(text, /enable_bucket = true/)
  assert.match(text, /\[\[datasets\.subsets\]\]/)
  // Windows 反斜杠路径原样进 literal string，不做转义
  assert.match(text, /image_dir = 'C:\\AIGC\\training\\style-v1\\img'/)
  assert.match(text, /num_repeats = 10/)
  // 能被 TOML 解析器吃下（node 22+ 内置 tomuki? 没有——手验括号与引号配对即可，
  // sd-scripts 侧由 python tomllib 解析，这里断言无未闭合引号）
  assert.equal(text.split("'").length % 2, 1, 'unbalanced quotes in toml')
})

test('buildTrainToml emits flat keys matching train_network.py args', () => {
  const text = buildTrainToml(params, paths)
  for (const key of [
    'pretrained_model_name_or_path',
    'output_dir',
    'output_name',
    'save_precision',
    'mixed_precision',
    'network_module',
    'network_dim',
    'network_alpha',
    'optimizer_type',
    'unet_lr',
    'text_encoder_lr',
    'lr_scheduler',
    'max_train_epochs',
    'gradient_checkpointing',
    'cache_latents_to_disk',
    'clip_skip',
    'min_snr_gamma',
    'sdpa',
  ]) {
    assert.ok(text.includes(`${key} = `), `missing key: ${key}`)
  }
  assert.match(text, /network_module = 'networks\.lora'/)
  assert.match(text, /optimizer_type = 'AdamW8bit'/)
  assert.match(text, /clip_skip = 2/)
  // sdxl 不是 train_network.py 的合法参数（SDXL 走独立脚本），进 TOML 必炸
  assert.ok(!text.includes('sdxl'), 'sdxl must not appear in toml')
  assert.ok(!text.includes('sample_prompts'), 'no sampling by default')
})

test('buildTrainToml adds sampling block when samplePrompts given', () => {
  const withSample = resolveParams({
    ...base,
    samplePrompts: 'masterpiece, 1girl\n',
    sampleEveryNEpochs: 2,
  })
  const text = buildTrainToml(withSample, paths)
  assert.match(text, /sample_prompts = /)
  assert.match(text, /sample_every_n_epochs = 2/)
  assert.match(text, /sample_at_first = false/)
})

test('literal strings survive single quotes in values', () => {
  const text = buildTrainToml(params, {
    ...paths,
    modelPath: "C:\\AIGC\\models\\weird's name.safetensors",
  })
  // 含单引号退回 basic string：反斜杠转义，单引号原样
  assert.match(text, /pretrained_model_name_or_path = "C:\\\\AIGC\\\\models\\\\weird's name\.safetensors"/)
})
