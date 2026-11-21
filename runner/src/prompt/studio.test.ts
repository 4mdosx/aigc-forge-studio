import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { join } from 'node:path'

import {
  cleanLlmText,
  groupsFrom,
  joinGroups,
  recomposeCanonical,
  splitPrompt,
  type CanonicalTable,
} from './studio.ts'

// 用真实发布的表跑测试，配置改坏了测试就红
const TABLE = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../data/prompt-canonical.json'), 'utf8'),
) as CanonicalTable

const FLAT = '1girl, animal_ears, breasts, pantyhose, playboy_bunny, bar_(place), rabbit_ears, drinking_glass, leotard, long_hair, gloves, bottle, fake_animal_ears, high_heels, cup, solo, wine_bottle, black_hair, black_gloves, black_leotard, bare_shoulders, looking_at_viewer, wine_glass, thighs, cleavage, highleg_leotard, coat, black_footwear, fur_trim, highleg, thigh_strap, legs, large_breasts, parted_lips, alcohol, bar_stool, hair_ornament, holding_cup, strapless_leotard, holding, full_body, indoors, multicolored_hair, dutch_angle, yellow_eyes, purple_hair, very_long_hair, sideboob, detached_collar, strapless, fur-trimmed_coat, black_pantyhose, black_coat, huge_breasts, cocktail_glass, armlet, red_eyes, thick_thighs, lips, skindentation, off_shoulder'

test('splitPrompt 分四组、去重、人数词优先', () => {
  const groups = splitPrompt(FLAT)
  assert.ok(groups.pose.includes('dutch_angle')) // 景别词归姿势与构图组
  assert.ok(groups.identity.includes('1girl'))
  assert.equal(groups.identity[0], '1girl') // 人数词排在最前
  assert.ok(groups.clothing.includes('black_leotard'))
  assert.ok(groups.pose.includes('full_body'))
  assert.ok(groups.pose.includes('looking_at_viewer'))
  // 去重（大小写不敏感）
  const dup = splitPrompt('1Girl, 1girl, solo, solo')
  assert.deepEqual(dup.identity, ['1Girl', 'solo'])
})

test('joinGroups 按四组顺序拼回平铺 prompt', () => {
  const groups = splitPrompt('standing, 1girl, zxstyle, dress')
  assert.equal(
    joinGroups(groups),
    'zxstyle, 1girl, dress, standing',
  )
})

test('groupsFrom 收数组与逗号串', () => {
  const got = groupsFrom({
    trigger: 'zxstyle, best quality',
    identity: ['1girl', 'solo'],
    clothing: 'dress',
  })
  assert.deepEqual(got.trigger, ['zxstyle', 'best quality'])
  assert.deepEqual(got.identity, ['1girl', 'solo'])
  assert.deepEqual(got.pose, [])
  assert.throws(() => groupsFrom({ trigger: 42 }), /groups\.trigger/)
})

test('recomposeCanonical 产出目标 12 词组（drop + 合成 + order）', () => {
  const text = recomposeCanonical(splitPrompt(FLAT), TABLE)
  assert.equal(
    text,
    '1girl, playboy bunny, rabbit ears, black highleg leotard, black pantyhose, black gloves, high heels, long multicolored hair, full body, looking at viewer',
  )
})

test('recomposeCanonical tokenBudget 截断', () => {
  const small = { ...TABLE, tokenBudget: 3 }
  const text = recomposeCanonical(splitPrompt(FLAT), small)
  assert.equal(text.split(', ').length, 3)
})

test('cleanLlmText 剥代码块围栏', () => {
  assert.equal(cleanLlmText('```\na, b\n```'), 'a, b')
  assert.equal(cleanLlmText('  a, b  '), 'a, b')
})
