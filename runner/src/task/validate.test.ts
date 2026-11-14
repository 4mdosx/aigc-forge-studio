import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PNG } from 'pngjs'

import { isDegeneratePng, MIN_DEVIATION_RATIO } from './validate.ts'

function makePng(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (png.width * y + x) << 2
      const [r, g, b] = paint(x, y)
      png.data[idx] = r
      png.data[idx + 1] = g
      png.data[idx + 2] = b
      png.data[idx + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

test('uniform image is degenerate', () => {
  const bytes = makePng(64, 64, () => [0, 0, 0])
  assert.equal(isDegeneratePng(bytes), true)
})

test('few stray dots on uniform background are degenerate', () => {
  // 模拟 SDPose 零星杂点失败：200x200 画布上 20 个点（0.05% < 0.1% 阈值）
  const bytes = makePng(200, 200, (x, y) =>
    x < 4 && y < 5 ? [0, 0, 255] : [0, 0, 0],
  )
  const ratio = (4 * 5) / (200 * 200)
  assert.ok(ratio < MIN_DEVIATION_RATIO, 'test precondition')
  assert.equal(isDegeneratePng(bytes), true)
})

test('skeleton-like line art passes validation', () => {
  // 模拟合格骨架：黑底 + ~1% 的彩色线条像素
  const bytes = makePng(128, 128, (x, y) =>
    y % 10 === 0 ? [0, 0, 255] : [0, 0, 0],
  )
  assert.equal(isDegeneratePng(bytes), false)
})

test('normal artwork passes validation', () => {
  const bytes = makePng(64, 64, (x, y) => [
    (x * 4) % 256,
    (y * 4) % 256,
    128,
  ])
  assert.equal(isDegeneratePng(bytes), false)
})

test('corrupt bytes are degenerate', () => {
  assert.equal(isDegeneratePng(new Uint8Array([1, 2, 3, 4])), true)
})
