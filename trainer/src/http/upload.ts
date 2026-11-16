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

// 原始字节流上传（不走 multipart，为大文件省一层解析）：
//   POST /upload?root=<name>&path=<rel>   body = raw bytes
export function mountUpload(app: Hono, trainer: Trainer): void {
  app.post('/upload', async (c) => {
    const root = c.req.query('root')
    if (!root) throw new TrainerError('root is required')
    const path = relativePath(c.req.query('path') ?? '')
    const target = resolveInRoot(trainer.roots, root, path.split('/'))
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

  // 取回已存文件（校验/回看用）：GET /files?root=<name>&path=<rel>
  app.get('/files', async (c) => {
    const root = c.req.query('root')
    if (!root) throw new TrainerError('root is required')
    const path = relativePath(c.req.query('path') ?? '')
    const target = resolveInRoot(trainer.roots, root, path.split('/'))
    try {
      await stat(target)
    } catch {
      throw new TrainerError('file not found', 404)
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
    if (!root) throw new TrainerError('root is required')
    const path = relativePath(c.req.query('path') ?? '')
    const target = resolveInRoot(trainer.roots, root, path.split('/'))
    const glob = c.req.query('glob')
    const info = await stat(target).catch(() => null)
    if (!info) throw new TrainerError('path not found', 404)

    if (info.isFile()) {
      if (glob) throw new TrainerError('glob is only valid when path is a directory')
      await rm(target)
      return c.json({ deleted: [`${root}/${path}`], count: 1 })
    }

    if (!glob) throw new TrainerError('glob is required when path is a directory')
    // 简易 glob：* → 任意段，? → 单字符，其余按字面量
    const re = new RegExp(
      '^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    )
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
