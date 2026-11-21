import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openDatabase } from '../db.ts'
import type { Runner } from '../task/queue.ts'
import { createApp } from './app.ts'

async function json(app: ReturnType<typeof createApp>, path: string): Promise<any> {
  const res = await app.request(path)
  return await res.json()
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aigc-data-'))
  mkdirSync(join(dir, 'pose'))
  const manifest = {
    poses: [
      { id: 'p1', enabled: true, source: 'openpose-lib', canvases: ['768512'] },
      { id: 'p2', enabled: true, source: 'openpose-lib', canvases: ['512768'] },
      { id: 'p3', enabled: true, source: 'img2pose', canvases: ['768512'] },
      { id: 'p4', enabled: false, source: 'legacy', canvases: ['512768'] },
    ],
  }
  writeFileSync(join(dir, 'pose', 'manifest.json'), JSON.stringify(manifest))
  const runner = {
    db: openDatabase(':memory:'),
    clients: [],
    chat: null,
    trainerBaseURL: null,
    dataDir: dir,
    timeoutMs: 600_000,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    randomSeed: () => 42,
  } as unknown as Runner
  return { app: createApp(runner), dir, runner }
}

test('GET /data/poses：source 精确筛选，可与 enabled/canvas 叠加', async () => {
  const { app, dir, runner } = setup()
  try {
    const all = await json(app, '/data/poses?enabled=true')
    assert.equal(all.total, 3) // disabled 的 p4 被排除
    assert.deepEqual(all.sources, ['img2pose', 'legacy', 'openpose-lib']) // 全量枚举含 disabled

    const lib = await json(app, '/data/poses?source=openpose-lib')
    assert.equal(lib.total, 2)
    assert.deepEqual(lib.poses.map((p: { id: string }) => p.id), ['p1', 'p2'])

    const own = await json(app, '/data/poses?source=img2pose')
    assert.equal(own.total, 1)
    assert.equal(own.poses[0].id, 'p3')

    const combo = await json(app, '/data/poses?source=openpose-lib&canvas=768512')
    assert.equal(combo.total, 1)
    assert.equal(combo.poses[0].id, 'p1')

    const missing = await json(app, '/data/poses?source=nope')
    assert.equal(missing.total, 0)
    assert.deepEqual(missing.poses, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
    runner.db.close()
  }
})

test('GET /data/poses：sources 不受筛选影响，始终返回全量枚举', async () => {
  const { app, dir, runner } = setup()
  try {
    const filtered = await json(app, '/data/poses?source=img2pose')
    assert.deepEqual(filtered.sources, ['img2pose', 'legacy', 'openpose-lib'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
    runner.db.close()
  }
})
