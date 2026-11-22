import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { Hono } from 'hono'

import type { Trainer } from '../download/manager.ts'
import { TrainerError } from '../errors.ts'
import { relativePath } from '../path.ts'
import { resolveInRoot } from '../roots.ts'
import { jsonObject } from './request.ts'

/** 列表条目：name 是相对请求 path 的 posix 路径（递归时含子目录前缀） */
export interface FileEntry {
  name: string
  isDir: boolean
  size: number
  mtime: string | null
}

// 简易 glob：* → 任意段，? → 单字符，其余按字面量。只做平层匹配，不跨目录。
function globToRegExp(glob: string): RegExp {
  return new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  )
}

// 一次解析出「规范化相对路径 + 绝对路径」。
// relativePath 内含一次 decodeURIComponent，所以 raw 只能喂进来一次——
// 调用方先自己 relativePath 再进来会二次解码，含 % 的文件名会解错。
// raw 为空表示 root 根本身（列 root 顶层用），这条捷径绕开 resolveInRoot
// ——它对空 parts 会判 invalid path。
function targetOf(
  trainer: Trainer,
  root: string | undefined,
  raw: string,
): { path: string; target: string } {
  if (!root) throw new TrainerError('root is required')
  const abs = trainer.roots[root]
  if (!abs) throw new TrainerError(`unknown root: ${root}`, 404)
  if (raw === '') return { path: '', target: abs }
  const path = relativePath(raw)
  return { path, target: resolveInRoot(trainer.roots, root, path.split('/')) }
}

const MAX_DEPTH = 8
const DEFAULT_LIMIT = 10000

// 原始字节流上传（不走 multipart，为大文件省一层解析）：
//   POST /upload?root=<name>&path=<rel>   body = raw bytes
export function mountUpload(app: Hono, trainer: Trainer): void {
  app.post('/upload', async (c) => {
    const root = c.req.query('root')
    const { path, target } = targetOf(trainer, root, c.req.query('path') ?? '')
    // 空 path 会落到 root 根目录，写成一个名为目录的文件——明确拒绝
    if (path === '') throw new TrainerError('path is required')
    await mkdir(join(target, '..'), { recursive: true })

    const body = c.req.raw.body
    if (!body) throw new TrainerError('request body is required')

    const hash = createHash('sha256')
    let size = 0
    await pipeline(
      Readable.fromWeb(body as unknown as import('node:stream/web').ReadableStream),
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          hash.update(chunk)
          size += chunk.length
          yield chunk
        }
      },
      createWriteStream(target, { flags: 'w' }),
    )
    return c.json({ path: `${root}/${path}`, size, sha256: hash.digest('hex') }, 201)
  })

  // 目录清单：GET /list?root=<name>&path=<rel>[&glob=*.png][&recursive=1][&limit=N]
  //   path 省略 → 列 root 顶层。count 只数文件，dirs 单独给，totalBytes 只算文件。
  //   这是核对「训练机上到底有什么」的唯一入口——GET /files 只取单文件。
  app.get('/list', async (c) => {
    const root = c.req.query('root')
    const { path, target } = targetOf(trainer, root, c.req.query('path') ?? '')
    const info = await stat(target).catch(() => null)
    if (!info) throw new TrainerError('path not found', 404)
    if (!info.isDirectory()) {
      throw new TrainerError('path is not a directory; use GET /files')
    }

    const glob = c.req.query('glob')
    const re = glob ? globToRegExp(glob) : null
    const recursive = ['1', 'true'].includes(c.req.query('recursive') ?? '')
    const limit = Number(c.req.query('limit') ?? '') || DEFAULT_LIMIT

    const entries: FileEntry[] = []
    let truncated = false

    async function walk(dir: string, prefix: string, depth: number): Promise<void> {
      for (const dirent of await readdir(dir, { withFileTypes: true })) {
        if (entries.length >= limit) {
          truncated = true
          return
        }
        const name = prefix ? `${prefix}/${dirent.name}` : dirent.name
        if (dirent.isDirectory()) {
          // 非递归 + 带 glob 时目录也要过滤，否则 `glob=*.png` 会把子目录一起列出来
          if (!recursive && re && !re.test(dirent.name)) continue
          entries.push({ name, isDir: true, size: 0, mtime: null })
          if (recursive && depth < MAX_DEPTH) {
            await walk(join(dir, dirent.name), name, depth + 1)
          }
          continue
        }
        if (!dirent.isFile()) continue // symlink / socket 一律跳过
        if (re && !re.test(dirent.name)) continue
        const st = await stat(join(dir, dirent.name)).catch(() => null)
        entries.push({
          name,
          isDir: false,
          size: st?.size ?? 0,
          mtime: st?.mtime.toISOString() ?? null,
        })
      }
    }

    await walk(target, '', 0)
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const files = entries.filter((entry) => !entry.isDir)
    return c.json({
      root,
      path,
      entries,
      count: files.length,
      dirs: entries.length - files.length,
      totalBytes: files.reduce((sum, entry) => sum + entry.size, 0),
      truncated,
    })
  })

  // 声明式对账：客户端先报「这批应该有哪些文件」，trainer 清掉多余的。
  //   POST /sync?root=training&path=ohou19/img   body = { "files": ["a.png","a.txt"] }
  //   → { kept, deleted, missing }
  //
  // 为什么不做成 /upload?prune=*：批量上传时每个请求都会清一遍，
  // 先传的文件会被后传的请求当成「多余」删掉。清理必须独立于写入。
  app.post('/sync', async (c) => {
    const { target } = targetOf(trainer, c.req.query('root'), c.req.query('path') ?? '')
    const info = await stat(target).catch(() => null)
    if (!info) throw new TrainerError('path not found', 404)
    if (!info.isDirectory()) throw new TrainerError('path must be a directory')

    const body = await jsonObject(c.req)
    const files = body.files
    if (!Array.isArray(files) || files.some((name) => typeof name !== 'string')) {
      throw new TrainerError('files must be an array of strings')
    }
    for (const name of files as string[]) {
      if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) {
        throw new TrainerError(`files must be flat file names: ${name}`)
      }
    }
    const keep = new Set(files as string[])
    const prune = body.prune !== false // 默认清理

    const present = (await readdir(target, { withFileTypes: true }))
      .filter((dirent) => dirent.isFile())
      .map((dirent) => dirent.name)

    const deleted: string[] = []
    if (prune) {
      for (const name of present) {
        if (keep.has(name)) continue
        await rm(join(target, name))
        deleted.push(name)
      }
    }
    const remaining = prune ? present.filter((name) => keep.has(name)) : present
    return c.json({
      kept: remaining,
      deleted,
      missing: [...keep].filter((name) => !present.includes(name)),
      count: remaining.length,
    })
  })

  // 取回已存文件（校验/回看用）：GET /files?root=<name>&path=<rel>
  app.get('/files', async (c) => {
    const root = c.req.query('root')
    const { path, target } = targetOf(trainer, root, c.req.query('path') ?? '')
    if (path === '') throw new TrainerError('path is required')
    const info = await stat(target).catch(() => null)
    if (!info) throw new TrainerError('file not found', 404)
    // 目录上 createReadStream 会读出空流却返回 200 —— 客户端因此以为「取到了，是空的」。
    // 明确拒绝，把调用方引到 /list。
    if (info.isDirectory()) {
      throw new TrainerError('path is a directory; use GET /list?root=&path=')
    }
    return c.body(
      Readable.toWeb(
        createReadStream(target),
      ) as unknown as ReadableStream,
      200,
    )
  })

  // 删除（受限）：DELETE /files?root=<name>&path=<rel>[&glob=<pattern>]
  //   path 指向文件 → 删单文件；path 指向目录 + glob → 只删该目录下匹配的文件
  //   （不递归子目录）。用例：训练前清 latent cache —— glob=*.npz。
  //   目录本身与子目录永不删除，防误伤。
  app.delete('/files', async (c) => {
    const root = c.req.query('root')
    const { path, target } = targetOf(trainer, root, c.req.query('path') ?? '')
    if (path === '') throw new TrainerError('path is required')
    const glob = c.req.query('glob')
    const info = await stat(target).catch(() => null)
    if (!info) throw new TrainerError('path not found', 404)

    if (info.isFile()) {
      if (glob) throw new TrainerError('glob is only valid when path is a directory')
      await rm(target)
      return c.json({ deleted: [`${root}/${path}`], count: 1 })
    }

    if (!glob) throw new TrainerError('glob is required when path is a directory')
    const re = globToRegExp(glob)
    const names = await readdir(target)
    const deleted: string[] = []
    for (const name of names) {
      if (!re.test(name)) continue
      const fp = join(target, name)
      if ((await stat(fp).catch(() => null))?.isFile()) {
        await rm(fp)
        deleted.push(`${root}/${path}/${name}`)
      }
    }
    return c.json({ deleted, count: deleted.length })
  })
}
