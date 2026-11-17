import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'

import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'
import { mountRecommend } from './recommend.ts'

function appAt(dataDir: string): Hono {
  const app = new Hono()
  app.onError((err, c) => {
    const status = err instanceof RunnerError ? err.status : 500
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, status as 400)
  })
  mountRecommend(app, { dataDir } as Runner)
  return app
}

test('POST /tag/recommend returns 10 or fewer tags from wd14-tags.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wd14-tags-'))
  writeFileSync(
    join(dir, 'wd14-tags.json'),
    JSON.stringify({
      a: 'animal_ears, animal_ear_fluff, fox_ears',
      b: 'animal_ears, animal_ear_fluff, fox_ears',
      c: 'animal_ears, pointy_ears, elf',
      d: 'animal_ears, pointy_ears, elf',
    }),
  )
  const res = await appAt(dir).request('/tag/recommend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tags: ['animal_ears', 'animal_ear_fluff', 'pointy_ears'],
    }),
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { recommendations: string[] }
  assert.deepEqual(body.recommendations, ['elf', 'fox_ears'])
})

test('POST /tag/recommend 404s when the tag table is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wd14-missing-'))
  const res = await appAt(dir).request('/tag/recommend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tags: ['animal_ears'] }),
  })
  assert.equal(res.status, 404)
})
