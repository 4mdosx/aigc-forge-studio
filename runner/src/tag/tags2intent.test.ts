import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compileRolePool, tagsToIntent } from './tags2intent.ts'

// 精简词池：section 名与 dice UI 的 intent schema 对齐（group.field）
const role = {
  'subject.type': ['1girl', 'solo'],
  'subject.description': ['blonde_hair', 'dragon_tail'],
  'outfit.clothing': ['maid_apron', 'dress'],
  'lighting.type': ['backlight'],
  'constraints.exclude': ['bad_hands'],
}

test('tags2intent: 命中词按词表归位，未命中词落 subject.description', () => {
  const pool = compileRolePool(role)
  const result = tagsToIntent(['1girl', 'maid_apron', 'dragon_tail', 'unknown_tag'], pool)
  assert.equal(result.intent.subject.type, '1girl')
  assert.equal(result.intent.outfit.clothing, 'maid_apron')
  assert.equal(result.intent.subject.description, 'dragon_tail,unknown_tag')
  assert.equal(result.total, 4)
  assert.equal(result.hit, 3)
  assert.equal(result.miss, 1)
})

test('tags2intent: prompt 汇总正向词且去重，negative 来自 exclude', () => {
  const pool = compileRolePool(role)
  const result = tagsToIntent(['1girl', '1girl', 'bad_hands', 'dress'], pool)
  // bad_hands 归到 constraints.exclude → negative；dress 归 outfit.clothing
  assert.equal(result.negative, 'bad_hands')
  assert.ok(result.positive.split(',').includes('1girl'))
  assert.ok(result.positive.split(',').includes('dress'))
  assert.equal(result.positive.split(',').filter((t) => t === '1girl').length, 1)
})

test('tags2intent: 空 tags 产出空 intent，覆盖统计为 0', () => {
  const pool = compileRolePool(role)
  const result = tagsToIntent([], pool)
  assert.equal(result.total, 0)
  assert.equal(result.hit, 0)
  assert.equal(result.positive, '')
  assert.deepEqual(result.intent.outfit.accessories, [])
})
