import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  applyCompose,
  ckptNameOf,
  composePrompt,
} from './promptCompose.ts'
import { RunnerError } from '../errors.ts'
import type { Prompt } from '../workflow/graph.ts'

describe('composePrompt', () => {
  // 黄金样例：2026-11-15 repaint 实测（takao animagine 底图 → uncanny 全转换）
  const illustrious = {
    qualityPos: 'start' as const,
    qualityStart: [
      'masterpiece',
      'best quality',
      'amazing quality',
      'very aesthetic',
      'absurdres',
    ],
    stripForeign: ['masterpiece', 'high score', 'great score', 'very awa', 'newest'],
    negativeBase: [
      'lowres',
      'worst quality',
      'signature',
      'watermark',
      'logo',
      'patreon logo',
    ],
  }

  it('illustrious 前置质量词 + 剥 animagine 句尾噪声 + 锚', () => {
    const out = composePrompt({
      materialPositive:
        'takao \\(azur lane\\), 1girl, lying down, white background, masterpiece, high score, great score, absurdres',
      anchors: ['white coat', 'gold buttons', 'bare legs'],
      negativeExtra: [],
      profile: illustrious,
    })
    assert.equal(
      out.positive,
      'masterpiece, best quality, amazing quality, very aesthetic, absurdres, takao \\(azur lane\\), 1girl, lying down, white background, white coat, gold buttons, bare legs',
    )
  })

  it('negative = 基座 + 素材 + 附加，去重保序', () => {
    const out = composePrompt({
      materialPositive: '1girl',
      materialNegative: 'blurry, bad anatomy',
      anchors: [],
      negativeExtra: ['patreon logo', 'artist name'],
      profile: illustrious,
    })
    assert.equal(
      out.negative,
      'lowres, worst quality, signature, watermark, logo, patreon logo, blurry, bad anatomy, artist name',
    )
  })

  it('animagine 端置质量词', () => {
    const out = composePrompt({
      materialPositive: '1girl, solo',
      anchors: [],
      negativeExtra: [],
      profile: {
        qualityPos: 'end',
        qualityEnd: ['masterpiece', 'high score'],
        stripForeign: ['best quality'],
      },
    })
    assert.equal(out.positive, '1girl, solo, masterpiece, high score')
  })

  it('剥词大小写不敏感', () => {
    const out = composePrompt({
      materialPositive: '1girl, Masterpiece, HIGH SCORE',
      anchors: [],
      negativeExtra: [],
      profile: illustrious,
    })
    assert.equal(out.positive, 'masterpiece, best quality, amazing quality, very aesthetic, absurdres, 1girl')
  })
})

describe('applyCompose', () => {
  const api = {
    '1': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: 'checkpoints/uncannyValley_ilxl10Noob.safetensors' },
    },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } },
  } as unknown as Prompt

  const adapter = {
    inputs: {},
    outputs: {},
    prompt: { compose: true, anchors: ['gold buttons'] },
  }

  it('组装后的 positive/negative 写回 payload，raw 字段删除', () => {
    const payload: Record<string, unknown> = {
      rawPositive: 'takao, masterpiece, high score',
      rawNegative: 'blurry',
      image: 'x.png',
      seed: 1,
    }
    // 走仓库真实 data fixture（promptProfiles.json + checkpoint 元数据）
    const dataDir = new URL('../../../data', import.meta.url).pathname
    applyCompose(api, adapter, payload, dataDir)
    assert.match(payload.positive as string, /^masterpiece, best quality/)
    assert.match(payload.positive as string, /takao, gold buttons$/)
    assert.equal(payload.rawPositive, undefined)
    assert.equal(payload.rawNegative, undefined)
    assert.match(payload.negative as string, /logo/)
  })

  it('无 compose 配置时传 raw 报错', () => {
    const payload = { rawPositive: 'x' }
    assert.throws(
      () => applyCompose(api, {}, payload, 'data'),
      RunnerError,
    )
  })

  it('compose 配置但缺 rawPositive 报错', () => {
    assert.throws(
      () => applyCompose(api, adapter, {}, 'data'),
      RunnerError,
    )
  })
})

describe('ckptNameOf', () => {
  it('取唯一 checkpoint', () => {
    const api = {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
    } as unknown as Prompt
    assert.equal(ckptNameOf(api), 'a.safetensors')
  })
  it('多 checkpoint 报错', () => {
    const api = {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a' } },
      '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'b' } },
    } as unknown as Prompt
    assert.throws(() => ckptNameOf(api), RunnerError)
  })
})
