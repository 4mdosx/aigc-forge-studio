import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { join } from 'node:path'

import {
  cleanLlmText,
  groupsFrom,
  joinGroups,
  parseThemeDraft,
  rankThemes,
  recomposeBank,
  recomposeCanonical,
  resolveTable,
  splitPrompt,
  type CanonicalBank,
} from './studio.ts'

// 用真实发布的 bank 跑测试，配置改坏了测试就红
const BANK = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../data/prompt-canonical.json'), 'utf8'),
) as CanonicalBank

const FLAT = '1girl, animal_ears, breasts, pantyhose, playboy_bunny, bar_(place), rabbit_ears, drinking_glass, leotard, long_hair, gloves, bottle, fake_animal_ears, high_heels, cup, solo, wine_bottle, black_hair, black_gloves, black_leotard, bare_shoulders, looking_at_viewer, wine_glass, thighs, cleavage, highleg_leotard, coat, black_footwear, fur_trim, highleg, thigh_strap, legs, large_breasts, parted_lips, alcohol, bar_stool, hair_ornament, holding_cup, strapless_leotard, holding, full_body, indoors, multicolored_hair, dutch_angle, yellow_eyes, purple_hair, very_long_hair, sideboob, detached_collar, strapless, fur-trimmed_coat, black_pantyhose, black_coat, huge_breasts, cocktail_glass, armlet, red_eyes, thick_thighs, lips, skindentation, off_shoulder'

test('splitPrompt 分四组、去重、人数词优先', () => {
  const groups = splitPrompt(FLAT)
  assert.ok(groups.pose.includes('dutch_angle')) // 景别词归姿势与构图组
  assert.ok(groups.identity.includes('1girl'))
  assert.equal(groups.identity[0], '1girl')
  assert.ok(groups.clothing.includes('black_leotard'))
  assert.ok(groups.pose.includes('full_body'))
  assert.ok(groups.pose.includes('looking_at_viewer'))
  const dup = splitPrompt('1Girl, 1girl, solo, solo')
  assert.deepEqual(dup.identity, ['1Girl', 'solo'])
})

test('joinGroups 按四组顺序拼回平铺 prompt', () => {
  const groups = splitPrompt('standing, 1girl, zxstyle, dress')
  assert.equal(joinGroups(groups), 'zxstyle, 1girl, dress, standing')
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

test('recomposeBank 用完整表库产出目标 12 词组（global + 题材 drop + 合成 + order）', () => {
  const got = recomposeBank(splitPrompt(FLAT), BANK)
  assert.equal(got.themeId, 'bunny-girl-bar')
  assert.equal(
    got.text,
    '1girl, playboy bunny, rabbit ears, black highleg leotard, black pantyhose, black gloves, high heels, long multicolored hair, full body, looking at viewer',
  )
})

test('recomposeCanonical tokenBudget 截断', () => {
  const { table } = resolveTable(['playboy_bunny'], BANK)
  const small = { ...table, tokenBudget: 3 }
  const text = recomposeCanonical(splitPrompt(FLAT), small)
  assert.equal(text.split(', ').length, 3)
})

test('rankThemes 按专有 tag 命中打分，通用词不参与', () => {
  assert.equal(rankThemes(['1girl', 'long_hair', 'looking_at_viewer'], BANK).length, 0)
  assert.equal(rankThemes(['playboy_bunny', '1girl'], BANK)[0]?.id, 'bunny-girl-bar')
  assert.equal(rankThemes(['kimono', 'obi', '1girl'], BANK)[0]?.id, 'kimono-classic')
  assert.equal(rankThemes(['mecha_musume', 'flight_deck'], BANK)[0]?.id, 'mecha-musume')
})

test('resolveTable 命中题材后合并 global 与题材表', () => {
  const { table, themeId } = resolveTable(['playboy_bunny', 'blurry', 'solo'], BANK)
  assert.equal(themeId, 'bunny-girl-bar')
  assert.ok(table.drop.includes('blurry')) // global drop 合进来了
  assert.ok(table.drop.includes('bar_(place)')) // 题材 drop 还在
  assert.ok(table.rules.some((rule) => rule.slot === 'theme'))
  assert.ok(table.rules.some((rule) => rule.slot === 'identity')) // global rule 合进来了
})

test('recomposeBank 三题材各自命中，输出不串味', () => {
  assert.match(recomposeBank(splitPrompt(FLAT), BANK).text, /playboy bunny/)
  const kimono = recomposeBank(
    splitPrompt('1girl, kimono, obi, long_hair, tabi, full_body'),
    BANK,
  )
  assert.equal(kimono.themeId, 'kimono-classic')
  assert.match(kimono.text, /white kimono/)
  assert.match(kimono.text, /obi sash/)
  assert.doesNotMatch(kimono.text, /playboy bunny/)

  const mecha = recomposeBank(
    splitPrompt('1girl, mecha_musume, powered_armor, flight_deck, rust, cables'),
    BANK,
  )
  assert.equal(mecha.themeId, 'mecha-musume')
  assert.match(mecha.text, /mecha musume/)
  assert.match(mecha.text, /heavy integrated armor/)
  assert.doesNotMatch(mecha.text, /rust|cables/) // 题材 drop 生效
})

test('recomposeBank 未命中走 global 托底', () => {
  const got = recomposeBank(
    splitPrompt('1girl, long_hair, dress, standing, blurry, watermark'),
    BANK,
  )
  assert.equal(got.themeId, null)
  assert.match(got.text, /^1girl/)
  assert.doesNotMatch(got.text, /blurry|watermark/) // global drop 生效
})

test('parseThemeDraft 收合法草案、剥围栏，拒绝坏表', () => {
  const draft = {
    version: 1,
    theme: 'maid-classic',
    router: ['maid_headdress', 'maid_uniform'],
    order: ['trigger', 'identity', 'theme', 'pose', 'other'],
    drop: ['indoors'],
    rules: [{ slot: 'theme', match: ['maid_uniform'], output: 'maid outfit' }],
    tokenBudget: 15,
  }
  const parsed = parseThemeDraft(`\`\`\`json\n${JSON.stringify(draft)}\n\`\`\``)
  assert.equal(parsed.theme, 'maid-classic')
  assert.equal(parsed.rules[0]?.slot, 'theme')

  assert.throws(() => parseThemeDraft('not json'), /合法 JSON/)
  assert.throws(
    () => parseThemeDraft(JSON.stringify({ ...draft, router: [] })),
    /router 不能为空/,
  )
  assert.throws(
    () => parseThemeDraft(JSON.stringify({ ...draft, theme: 'Bad Id' })),
    /kebab-case/,
  )
  assert.throws(
    () => parseThemeDraft(JSON.stringify({ ...draft, order: ['trigger'] })),
    /order 缺少/,
  )
})

test('cleanLlmText 剥代码块围栏', () => {
  assert.equal(cleanLlmText('```\na, b\n```'), 'a, b')
  assert.equal(cleanLlmText('  a, b  '), 'a, b')
})
