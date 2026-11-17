import { existsSync, readFileSync, statSync } from 'node:fs'
import type { Hono } from 'hono'
import { join } from 'node:path'

import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'
import {
  buildCooccur,
  readTagTable,
  recommendTags,
  WD14_TAGS_FILE,
  type CooccurIndex,
} from '../tag/cooccur.ts'
import { jsonObject } from './request.ts'

// POST /tag/recommend
// 词表：data/wd14-tags.json ，形状 { "文件名": "tag1,tag2,tag," }。
// 请求只收一组 tag，可选 weights（正数抬近邻，负数压近邻）。返回 10 个推荐词。

const cache = new Map<string, { mtimeMs: number; index: CooccurIndex }>()

function indexOf(dataDir: string): CooccurIndex {
  const path = join(dataDir, WD14_TAGS_FILE)
  if (!existsSync(path)) {
    throw new RunnerError(`wd14 tag table missing at ${path}`, 404)
  }
  const mtimeMs = statSync(path).mtimeMs
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === mtimeMs) return hit.index
  let table: Record<string, string>
  try {
    table = readTagTable(readFileSync(path, 'utf8'))
  } catch (err) {
    if (err instanceof RunnerError) throw err
    throw new RunnerError(
      `invalid wd14-tags.json: ${err instanceof Error ? err.message : String(err)}`,
      500,
    )
  }
  const index = buildCooccur(table)
  cache.set(path, { mtimeMs, index })
  return index
}

function parseWeights(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RunnerError('weights must be an object of tag → number')
  }
  const weights: Record<string, number> = {}
  for (const [tag, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RunnerError(`weights.${tag} must be a finite number`)
    }
    weights[tag] = value
  }
  return weights
}

export function mountRecommend(app: Hono, runner: Runner): void {
  app.post('/tag/recommend', async (c) => {
    const body = await jsonObject(c.req)
    if (
      !Array.isArray(body.tags) ||
      body.tags.some((tag) => typeof tag !== 'string')
    ) {
      throw new RunnerError('tags must be a string array')
    }
    if (body.tags.length === 0) throw new RunnerError('tags must not be empty')
    const weights =
      body.weights === undefined ? undefined : parseWeights(body.weights)
    const recommendations = recommendTags(
      indexOf(runner.dataDir),
      body.tags as string[],
      {
        weights,
      },
    )
    return c.json({ recommendations })
  })
}
