import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { Hono } from 'hono'
import { join } from 'node:path'

import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'

interface ManifestEntry {
  id: string
  nsfw?: boolean
  enabled?: boolean
  canvas?: string
  canvases?: string[]
  poseName?: string | string[]
  compositionName?: string
  [key: string]: unknown
}

interface Manifest {
  generatedAt?: string
  poses?: ManifestEntry[]
  compositions?: ManifestEntry[]
  [key: string]: unknown
}

// data/ 是项目资产唯一真相源（pose/composition/character），本模块提供只读 API
export function mountData(app: Hono, runner: Runner): void {
  const root = runner.dataDir

  const loadManifest = (): Manifest => {
    const path = join(root, 'pose', 'manifest.json')
    if (!existsSync(path)) {
      throw new RunnerError(
        `data manifest missing at ${path}; run tools/build-pose-manifest.mjs`,
        404,
      )
    }
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Manifest
    } catch (err) {
      throw new RunnerError(
        `invalid manifest JSON: ${err instanceof Error ? err.message : String(err)}`,
        500,
      )
    }
  }

  app.get('/data/manifest', (c) => c.json(loadManifest()))

  app.get('/data/poses', (c) => {
    const manifest = loadManifest()
    const poses = manifest.poses ?? []
    const canvas = c.req.query('canvas')
    const filtered = poses.filter(
      (p) =>
        flagMatches(p.enabled, c.req.query('enabled')) &&
        flagMatches(p.nsfw, c.req.query('nsfw')) &&
        (!canvas || (p.canvases ?? []).includes(canvas)),
    )
    return c.json({ total: filtered.length, poses: filtered })
  })

  app.get('/data/compositions', (c) => {
    const manifest = loadManifest()
    const compositions = manifest.compositions ?? []
    const canvas = c.req.query('canvas')
    const pose = c.req.query('pose')
    const filtered = compositions.filter(
      (p) =>
        flagMatches(p.enabled, c.req.query('enabled')) &&
        flagMatches(p.nsfw, c.req.query('nsfw')) &&
        (!canvas || p.canvas === canvas) &&
        (!pose || poseMatches(p, pose)),
    )
    return c.json({ total: filtered.length, compositions: filtered })
  })

  app.get('/data/characters', (c) => {
    const dir = join(root, 'character')
    if (!existsSync(dir)) {
      throw new RunnerError(`data/character missing at ${dir}`, 404)
    }
    const characters = listDirs(dir).map((slug) => {
      const base = join(dir, slug)
      const refs = safeList(join(base, 'ref'))
      return {
        slug,
        hasRecipe: existsSync(join(base, 'recipe.json')),
        files: safeList(base),
        refCount: refs.length,
      }
    })
    return c.json({ total: characters.length, characters })
  })

  app.get('/data/characters/:slug', (c) => {
    const slug = c.req.param('slug')
    if (!/^[A-Za-z0-9_-]+$/.test(slug)) {
      throw new RunnerError('invalid character slug', 400)
    }
    const base = join(root, 'character', slug)
    if (!existsSync(base)) {
      throw new RunnerError(`character ${slug} not found`, 404)
    }
    const recipePath = join(base, 'recipe.json')
    const recipe = existsSync(recipePath)
      ? (JSON.parse(readFileSync(recipePath, 'utf8')) as unknown)
      : null
    return c.json({
      slug,
      recipe,
      refs: safeList(join(base, 'ref')),
      files: safeList(base),
    })
  })
}

function flagMatches(
  value: boolean | undefined,
  query: string | undefined,
): boolean {
  if (query === undefined) return true
  if (query === 'true') return value === true
  if (query === 'false') return value !== true
  throw new RunnerError(`boolean query param must be true or false`, 400)
}

// composition.poseName 支持数组通配 "*"（empty 构图匹配所有 pose）
function poseMatches(entry: ManifestEntry, pose: string): boolean {
  const names = Array.isArray(entry.poseName)
    ? entry.poseName
    : [entry.poseName ?? entry.compositionName ?? '']
  return names.includes('*') || names.includes(pose)
}

function listDirs(dir: string): string[] {
  return readdirSync(dir).filter((name) => {
    if (name.startsWith('.') || name.includes('.')) return false
    try {
      return statSync(join(dir, name)).isDirectory()
    } catch {
      return false
    }
  })
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith('.'))
  } catch {
    return []
  }
}
