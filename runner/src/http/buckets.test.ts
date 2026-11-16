import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  BUCKET_FAMILIES,
  parseCanvasKey,
  resolveNearestBucket,
} from '../workflow/buckets.ts'

describe('parseCanvasKey', () => {
  it('parses the three canonical pose canvas keys', () => {
    assert.deepEqual(parseCanvasKey('512768'), { width: 512, height: 768 })
    assert.deepEqual(parseCanvasKey('768512'), { width: 768, height: 512 })
    assert.deepEqual(parseCanvasKey('512512'), { width: 512, height: 512 })
  })
  it('parses non-uniform digit lengths', () => {
    assert.deepEqual(parseCanvasKey('8321216'), { width: 832, height: 1216 })
  })
  it('rejects garbage keys', () => {
    assert.throws(() => parseCanvasKey('12'))
  })
})

describe('resolveNearestBucket', () => {
  it('maps 2:3 pose to the 832x1216 sdxl bucket', () => {
    assert.deepEqual(resolveNearestBucket('sdxl', 512, 768), {
      width: 832,
      height: 1216,
    })
  })
  it('maps 3:2 pose to the 1216x832 sdxl bucket', () => {
    assert.deepEqual(resolveNearestBucket('sdxl', 768, 512), {
      width: 1216,
      height: 832,
    })
  })
  it('maps 1:1 pose to 1024x1024', () => {
    assert.deepEqual(resolveNearestBucket('sdxl', 512, 512), {
      width: 1024,
      height: 1024,
    })
  })
  it('sd15 family identity-maps the pose canvases', () => {
    for (const [w, h] of [
      [512, 768],
      [768, 512],
      [512, 512],
    ]) {
      assert.deepEqual(resolveNearestBucket('sd15', w, h), { width: w, height: h })
    }
  })
  it('rejects unknown families', () => {
    assert.throws(() => resolveNearestBucket('flux', 512, 768))
  })
  it('all sdxl buckets are 64-aligned near 1MP', () => {
    for (const b of BUCKET_FAMILIES.sdxl.buckets) {
      assert.equal(b.width % 64, 0)
      assert.equal(b.height % 64, 0)
      const area = b.width * b.height
      assert.ok(area > 900_000 && area < 1_150_000, `${b.width}x${b.height}`)
    }
  })
})
