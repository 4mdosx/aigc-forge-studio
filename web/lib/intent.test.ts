import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applyPatch,
  initialIntent,
  parseReply,
  type CreativeIntent,
} from './intent.ts'

const witch: CreativeIntent = {
  subject: { type: 'character', description: 'adult silver-haired witch' },
  outfit: { clothing: 'black gothic dress', accessories: ['black stockings'] },
  pose: { action: 'standing', expression: 'gentle smile' },
  composition: { shot: 'full body', view: 'front', framing: 'centered' },
  environment: { background: 'simple white background' },
  lighting: { type: 'soft studio lighting' },
  style: { genre: 'modern anime illustration', rendering: 'delicate shading' },
  constraints: { exclude: ['cropped feet', 'text', 'watermark'] },
}

test('a patch fills the creative intent and replaces arrays', () => {
  assert.deepEqual(applyPatch(initialIntent, witch), witch)
  const changed = applyPatch(witch, {
    outfit: { accessories: ['silver necklace'] },
    subject: { description: 'adult witch' },
  })
  assert.deepEqual(changed.outfit.accessories, ['silver necklace'])
  assert.equal(changed.outfit.clothing, 'black gothic dress')
  assert.equal(changed.subject.description, 'adult witch')
  assert.equal(changed.subject.type, 'character')
})

test('null restores a field and an empty patch keeps the document', () => {
  const cleared = applyPatch(witch, { lighting: { type: null } })
  assert.equal(cleared.lighting.type, '')
  assert.equal(applyPatch(witch, {}), witch)
  assert.throws(
    () => applyPatch(witch, { subject: { mood: 'calm' } }),
    /unknown field subject\.mood/,
  )
})

test('a reply is a message plus a patch object', () => {
  assert.deepEqual(
    parseReply(
      '```json\n{"message":" 好 ","patch":{"pose":{"action":"sitting"}}}\n```',
    ),
    { message: '好', patch: { pose: { action: 'sitting' } } },
  )
  assert.throws(() => parseReply('hello'), /LLM did not return JSON/)
  assert.throws(
    () => parseReply('{"message":"","patch":{}}'),
    /message and patch/,
  )
})
