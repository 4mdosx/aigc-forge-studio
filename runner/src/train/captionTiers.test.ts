import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  TIERS,
  captionFor,
  keepTag,
  normalizeTier,
} from './captionTiers.ts'

const TAGS = [
  '1girl', 'solo', 'white_hair', 'red_eyes', 'animal_ears',
  'flight_deck', 'rigging', 'mechanical_arms', 'armor', 'gold_trim',
  'white_background', 'simple_background', 'lowres', 'watermark',
  'sitting', 'looking_at_viewer', 'cowboy_shot',
  'hatsune_miku',
]
const CHARS = new Set(['hatsune_miku'])
const STYLE = ['painterly', 'dark cinematic lighting']

function cap(tier: Parameters<typeof captionFor>[1]['tier'], tags = TAGS): string {
  return captionFor(tags, { trigger: 'zxstyle', tier, styleTags: STYLE, charNames: CHARS })
}

test('normalizeTier：大小写与留空', () => {
  assert.equal(normalizeTier('t0'), 'T0')
  assert.equal(normalizeTier(' T3 '), 'T3')
  assert.equal(normalizeTier(null), null)
  assert.equal(normalizeTier(''), null)
  assert.throws(() => normalizeTier('T9'), /未知 caption 档位/)
})

test('tier 元数据不再携带 styleRequired（风格词全程可选）', () => {
  assert.equal('styleRequired' in TIERS.T0, false)
  assert.equal('styleRequired' in TIERS.T1, false)
})

test('T0 纯风格：WD14 tag 全删，只留触发词 + 恒定风格词', () => {
  assert.equal(cap('T0'), 'zxstyle, painterly, dark cinematic lighting,')
})

test('T0/T1 风格词可留空：T0 只剩触发词，T1 只剩设计 tag', () => {
  const noStyle = { trigger: 'zxstyle', tier: 'T0' as const, styleTags: [], charNames: CHARS }
  assert.equal(captionFor(TAGS, noStyle), 'zxstyle,')

  const t1 = { ...noStyle, tier: 'T1' as const }
  const got = captionFor(TAGS, t1)
  assert.match(got, /^zxstyle, flight_deck/)
  assert.doesNotMatch(got, /painterly|1girl|white_hair/)
})

test('T1 设计语言：只留设计/机械 tag', () => {
  const got = cap('T1')
  for (const word of ['flight_deck', 'rigging', 'mechanical_arms', 'armor', 'gold_trim']) {
    assert.match(got, new RegExp(word))
  }
  for (const word of ['1girl', 'white_hair', 'red_eyes', 'sitting', 'white_background']) {
    assert.doesNotMatch(got, new RegExp(word))
  }
})

test('T2 概念题材：留题材/服装，删身份细节/姿势/背景', () => {
  const got = cap('T2')
  for (const word of ['flight_deck', 'rigging', 'armor', '1girl']) {
    assert.match(got, new RegExp(word))
  }
  for (const word of ['white_hair', 'red_eyes', 'animal_ears', 'sitting', 'white_background', 'lowres']) {
    assert.doesNotMatch(got, new RegExp(word))
  }
})

test('T3 角色身份：留身份，删姿势/背景/画质/角色名', () => {
  const got = cap('T3')
  for (const word of ['white_hair', 'red_eyes', 'animal_ears', 'flight_deck']) {
    assert.match(got, new RegExp(word))
  }
  for (const word of ['sitting', 'looking_at_viewer', 'cowboy_shot', 'white_background', 'lowres', 'hatsune_miku']) {
    assert.doesNotMatch(got, new RegExp(word))
  }
})

test('原样档（tier=null）：触发词 + 全量 tag，仅剥角色名', () => {
  const got = cap(null)
  assert.match(got, /white_background/)
  assert.match(got, /sitting/)
  assert.doesNotMatch(got, /hatsune_miku/) // 角色名仍剥
  // dryRun/命令行如果不给角色词表，连角色名也留——由 charNames 空集决定
  const noChars = captionFor(TAGS, { trigger: 'zxstyle', tier: null, styleTags: [], charNames: new Set() })
  assert.match(noChars, /hatsune_miku/)
})

test('keepTag：画质/背景/角色名在任何档都删', () => {
  for (const tier of ['T0', 'T1', 'T2', 'T3'] as const) {
    assert.equal(keepTag('white_background', tier, CHARS), false)
    assert.equal(keepTag('watermark', tier, CHARS), false)
    assert.equal(keepTag('hatsune_miku', tier, CHARS), false)
  }
})

test('恒定风格词顺序：触发词在最前', () => {
  for (const tier of ['T0', 'T1', 'T2', 'T3'] as const) {
    assert.ok(cap(tier).startsWith('zxstyle, '))
  }
})
