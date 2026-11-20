import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  clearStoredPin,
  getPinEpoch,
  isPinConfigured,
  readAuth,
  savePin,
  verifyStoredPin,
} from './auth-store.ts'
import { gateDecision } from './gate.ts'
import { hashPin, pinMatches } from './pin-crypto.ts'
import { endOfLocalDay, readSession, signSession } from './session.ts'

test('scrypt hash matches only the same pin', async () => {
  const hash = await hashPin('1234')
  assert.equal(await pinMatches('1234', hash), true)
  assert.equal(await pinMatches('9999', hash), false)
  assert.equal(await pinMatches('1234', 'plain'), false)
  assert.equal(await pinMatches('1234', 'scrypt$zz$aa'), false)
})

test('session signature rejects tampering, the wrong secret, and expiry', () => {
  const secret = 'a'.repeat(32)
  const token = signSession({ exp: Date.now() + 60_000, pinEpoch: 'epoch-1' }, secret)
  assert.equal(readSession(token, secret)?.pinEpoch, 'epoch-1')
  assert.equal(readSession(token, `${secret}x`), null)
  const [body] = token.split('.')
  assert.equal(readSession(`${body}.aaaa`, secret), null)
  const expired = signSession({ exp: Date.now() - 1, pinEpoch: 'epoch-1' }, secret)
  assert.equal(readSession(expired, secret), null)
})

test('local day session ends at the next midnight', () => {
  const now = new Date(2026, 10, 20, 15, 4, 0)
  assert.equal(endOfLocalDay(now).getTime(), new Date(2026, 10, 21, 0, 0, 0).getTime())
})

test('stored pin rotates the epoch and the gate follows it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aigc-pin-'))
  const file = join(dir, 'web-auth.json')
  try {
    assert.equal(isPinConfigured(file), false)
    await savePin('1234', file)
    assert.equal(await verifyStoredPin('1234', file), true)
    assert.equal(await verifyStoredPin('0000', file), false)
    const first = getPinEpoch(file)
    assert.ok(first)
    const auth = readAuth(file)
    const token = signSession({ exp: Date.now() + 60_000, pinEpoch: first }, auth.secret ?? '')
    assert.equal(gateDecision('/', token, auth), 'allow')
    assert.equal(gateDecision('/login', undefined, {}), 'allow')
    assert.equal(gateDecision('/api/runner/tasks', undefined, auth), 'deny')
    assert.equal(gateDecision('/', token, { ...auth, epoch: 'other' }), 'deny')

    await savePin('5678', file)
    const next = readAuth(file)
    assert.notEqual(next.epoch, first)
    assert.equal(await verifyStoredPin('1234', file), false)
    assert.equal(await verifyStoredPin('5678', file), true)
    assert.equal(gateDecision('/', token, next), 'deny')
    assert.equal(next.secret, auth.secret)

    assert.equal(clearStoredPin(file), true)
    assert.equal(isPinConfigured(file), false)
    assert.equal(getPinEpoch(file), null)
    assert.equal(gateDecision('/', token, readAuth(file)), 'deny')
    assert.equal(clearStoredPin(file), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
