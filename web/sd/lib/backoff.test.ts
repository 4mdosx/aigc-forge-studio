import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  backoffMs,
  clearSignal,
  describeRemaining,
  failureCount,
  lockedFor,
  recordFailure,
  recordFailureSignal,
  recordSuccess,
  resetBackoff,
} from './backoff.ts'

test('backoff grows by 3x and caps at 24 hours', () => {
  assert.equal(backoffMs(1), 30_000)
  assert.equal(backoffMs(2), 90_000)
  assert.equal(backoffMs(3), 270_000)
  assert.equal(backoffMs(8), 30_000 * 3 ** 7)
  assert.equal(backoffMs(9), 24 * 60 * 60 * 1000)
  assert.equal(backoffMs(40), 24 * 60 * 60 * 1000)
  assert.equal(backoffMs(0), 0)
})

test('failures accumulate until success, and a lock does not extend itself', () => {
  resetBackoff()
  const start = 1_000_000
  recordFailure('local', undefined, start)
  assert.equal(lockedFor('local', start + 1_000), 29_000)
  assert.equal(failureCount('local'), 1)
  recordFailure('local', undefined, start + 30_000)
  assert.equal(failureCount('local'), 2)
  assert.equal(lockedFor('local', start + 30_000), 90_000)
  recordSuccess('local')
  clearSignal('local')
  assert.equal(failureCount('local'), 0)
  assert.equal(lockedFor('local', start + 30_000), 0)
})

test('describeRemaining keeps the server clock in the message', () => {
  assert.equal(describeRemaining(30_000), '请 30 秒后再试')
  assert.equal(describeRemaining(90_000), '请 2 分钟后再试')
  assert.equal(describeRemaining(24 * 60 * 60 * 1000), '已被锁定 24 小时')
})

test('five failures inside the window are a burst', () => {
  resetBackoff()
  const now = 5_000_000
  let signal = recordFailureSignal('10.0.0.8', undefined, now)
  for (let i = 0; i < 4; i += 1) signal = recordFailureSignal('10.0.0.8', undefined, now + i)
  assert.equal(signal.suspicious, true)
  assert.equal(signal.reason, 'burst')
  assert.equal(signal.failures, 5)
})
