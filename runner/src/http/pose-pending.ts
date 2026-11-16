import { execFile as execFileCb } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { Hono } from 'hono'

import { taskById } from '../db.ts'
import { RunnerError } from '../errors.ts'
import { relativePath } from '../path.ts'
import { storedPaths } from '../task/records.ts'
import type { Runner } from '../task/queue.ts'
import { jsonObject } from './request.ts'

const execFile = promisify(execFileCb)

// 条目内允许出现的文件（服务与迁移白名单）
const ENTRY_FILES = [
  'source.png',
  'source_orig.png',
  'depth.png',
  'depth_preview.png',
  'skeleton.png',
  'meta.json',
] as const

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.json': 'application/json',
}

// manifest builder（唯一真相源）：data/../../tools/build-pose-manifest.mjs
function manifestScript(runner: Runner): string {
  return join(runner.dataDir, '..', '..', 'tools', 'build-pose-manifest.mjs')
}

async function rebuildManifest(runner: Runner): Promise<string> {
  const script = manifestScript(runner)
  if (!existsSync(script)) {
    throw new RunnerError(`manifest builder missing: ${script}`, 500)
  }
  const { stdout, stderr } = await execFile('node', [script], { timeout: 30_000 })
  return (stdout + stderr).trim()
}

interface PendingEntry {
  poseName: string
  id: string
  meta: Record<string, unknown>
  files: string[]
  dual: { taskId: string; status: string; image: string | null } | null
}

function scanPending(runner: Runner): PendingEntry[] {
  const root = join(runner.dataDir, 'pose_pending')
  const entries: PendingEntry[] = []
  if (!existsSync(root)) return entries
  for (const poseName of readdirSync(root)) {
    const poseDir = join(root, poseName)
    if (poseName.startsWith('_') || poseName.startsWith('.')) continue
    try {
      if (!readdirSync(poseDir)) continue
    } catch {
      continue // poseName 是文件等异常情况，跳过
    }
    for (const id of readdirSync(poseDir)) {
      const dir = join(poseDir, id)
      const metaPath = join(dir, 'meta.json')
      if (id.startsWith('.') || !existsSync(metaPath)) continue
      let meta: Record<string, unknown>
      try {
        meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
      } catch {
        meta = { id, poseName, name: `invalid meta: ${id}` }
      }
      const files = ENTRY_FILES.filter((name) => existsSync(join(dir, name)))
      let dual: PendingEntry['dual'] = null
      const dualTaskId = typeof meta.dualTaskId === 'string' ? meta.dualTaskId : null
      if (dualTaskId) {
        try {
          const task = taskById(runner.db, dualTaskId)
          const outputs = storedPaths(task).filter((p) => p.startsWith('output/'))
          dual = {
            taskId: dualTaskId,
            status: task.status,
            image: outputs[0] ?? null,
          }
        } catch {
          dual = { taskId: dualTaskId, status: 'unknown', image: null }
        }
      }
      entries.push({ poseName, id, meta, files, dual })
    }
  }
  // 新条目在前
  entries.sort((a, b) => b.id.localeCompare(a.id))
  return entries
}

function assertEntry(runner: Runner, poseName: string, id: string): {
  dir: string
  meta: Record<string, unknown>
} {
  if (!/^[a-z][a-z0-9_]*$/.test(poseName)) {
    throw new RunnerError('invalid poseName', 400)
  }
  if (!/^[0-9]+$/.test(id)) throw new RunnerError('invalid pose id', 400)
  const dir = join(runner.dataDir, 'pose_pending', poseName, id)
  const metaPath = join(dir, 'meta.json')
  if (!existsSync(metaPath)) {
    throw new RunnerError(`pending entry not found: ${poseName}/${id}`, 404)
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
  return { dir, meta }
}

// 审批通过：pose_pending/<poseName>/<id>/ → data/pose/<poseName>/<id>/
//   depth.png → depth.png，skeleton.png → bone.png，
//   pose.json（若有）→ pose.json；meta.json 就地 enabled:true。
// 画布分辨率记录在 meta.canvases，条目内不再建 <canvas> 子目录（2026-11-17）。
// 溯源件（source/source_orig/depth_preview）留在条目根，不进 manifest。
// 迁移后重跑 tools/build-pose-manifest.mjs 重建 data/pose/manifest.json。
export function mountPosePending(app: Hono, runner: Runner): void {
  app.get('/poses/pending', (c) => {
    const entries = scanPending(runner)
    return c.json({
      total: entries.length,
      entries: entries.map((e) => ({
        poseName: e.poseName,
        id: e.id,
        meta: e.meta,
        files: e.files,
        dual: e.dual,
        fileUrls: Object.fromEntries(
          e.files.map((name) => [
            name.replace(/\.png$/, '').replace(/\.json$/, ''),
            `/poses/pending/file/${e.poseName}/${e.id}/${name}`,
          ]),
        ),
      })),
    })
  })

  app.get('/poses/pending/file/*', (c) => {
    const path = relativePath(c.req.path.slice('/poses/pending/file/'.length))
    const parts = path.split('/')
    if (parts.length !== 3) throw new RunnerError('invalid pending file path', 400)
    const [poseName, id, name] = parts as [string, string, string]
    if (!(ENTRY_FILES as readonly string[]).includes(name)) {
      throw new RunnerError(`file not allowed: ${name}`, 400)
    }
    const { dir } = assertEntry(runner, poseName, id)
    const abs = join(dir, name)
    if (!existsSync(abs)) throw new RunnerError(`file missing: ${name}`, 404)
    const ext = name.slice(name.lastIndexOf('.'))
    return c.body(new Uint8Array(readFileSync(abs)).buffer as ArrayBuffer, 200, {
      'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    })
  })

  // 审核就地编辑 meta.json（name/description/tags），approve 前保存用
  app.post('/poses/pending/edit', async (c) => {
    const body = await jsonObject(c.req)
    const poseName = String(body.poseName ?? '')
    const id = String(body.id ?? '')
    const { dir, meta } = assertEntry(runner, poseName, id)
    const next: Record<string, unknown> = { ...meta }
    if (typeof body.name === 'string' && body.name.trim() !== '') next.name = body.name.trim()
    if (typeof body.description === 'string') next.description = body.description.trim()
    if (Array.isArray(body.tags)) {
      const tags = (body.tags as unknown[])
        .map((t) => String(t).trim())
        .filter(Boolean)
      if (tags.length > 0) next.tags = tags
    }
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(next, null, 2))
    return c.json({ updated: `${poseName}/${id}`, meta: next })
  })

  app.post('/poses/pending/approve', async (c) => {
    const body = await jsonObject(c.req)
    const poseName = String(body.poseName ?? '')
    const id = String(body.id ?? '')
    const { dir, meta } = assertEntry(runner, poseName, id)

    const canvases = (meta.canvases as string[] | undefined) ?? []
    if (!(canvases[0] && /^\d{6}$/.test(canvases[0]))) {
      throw new RunnerError(`entry ${poseName}/${id} has no valid canvas`, 400)
    }

    const target = join(runner.dataDir, 'pose', poseName, id)
    if (existsSync(target)) {
      throw new RunnerError(`formal entry already exists: pose/${poseName}/${id}`, 409)
    }

    mkdirSync(target, { recursive: true })

    // 产物迁入正式 schema（文件直接落在条目根）；缺件直接报错（半成品不该过审）
    for (const [src, dst] of [
      ['depth.png', 'depth.png'],
      ['skeleton.png', 'bone.png'],
      ['pose.json', 'pose.json'],
    ] as const) {
      const from = join(dir, src)
      if (!existsSync(from)) {
        if (src === 'pose.json') continue // img2pose 链路无 keypoints json，manifest 允许 null
        throw new RunnerError(`entry missing product: ${src}`, 400)
      }
      renameSync(from, join(target, dst))
    }
    for (const keep of ['source.png', 'source_orig.png', 'depth_preview.png']) {
      const from = join(dir, keep)
      if (existsSync(from)) renameSync(from, join(target, keep))
    }
    // 剩余溯源件（旧格式 source.jpg / depth_raw.png / review_grid.png 等）一并搬走，不丢弃
    for (const rest of readdirSync(dir)) {
      const from = join(dir, rest)
      if (existsSync(from) && statSync(from).isFile() && !existsSync(join(target, rest))) {
        renameSync(from, join(target, rest))
      }
    }

    // meta 正本：enabled 翻 true，允许审批时覆写 name/tags
    const nextMeta: Record<string, unknown> = {
      ...meta,
      id,
      poseName,
      enabled: true,
      name: typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : meta.name,
      description:
        typeof body.description === 'string' && body.description.trim() !== ''
          ? body.description.trim()
          : meta.description,
      tags: Array.isArray(body.tags)
        ? (body.tags as string[]).map((t) => String(t).trim()).filter(Boolean)
        : meta.tags,
    }
    delete nextMeta.ratio // 512 系画布已由 canvases 表达，ratio 不进正式库
    delete nextMeta.dualTaskId
    delete nextMeta.img2poseTaskId
    writeFileSync(join(target, 'meta.json'), JSON.stringify(nextMeta, null, 2))
    rmSync(dir, { recursive: true })

    let manifest = ''
    let manifestError: string | null = null
    try {
      manifest = await rebuildManifest(runner)
    } catch (err) {
      manifestError = err instanceof Error ? err.message : String(err)
    }
    return c.json({ approved: `${poseName}/${id}`, target: `pose/${poseName}/${id}`, manifest, manifestError }, 201)
  })

  // 驳回：移入 pose_pending/_trash/（可人工找回，不直接删）
  app.post('/poses/pending/reject', async (c) => {
    const body = await jsonObject(c.req)
    const poseName = String(body.poseName ?? '')
    const id = String(body.id ?? '')
    const { dir } = assertEntry(runner, poseName, id)
    const trash = join(runner.dataDir, 'pose_pending', '_trash')
    mkdirSync(trash, { recursive: true })
    const dest = join(trash, `${runner.now().getTime()}_${poseName}_${id}`)
    renameSync(dir, dest)
    return c.json({ rejected: `${poseName}/${id}`, trash: dest.replace(runner.dataDir + '/', '') }, 201)
  })
}
