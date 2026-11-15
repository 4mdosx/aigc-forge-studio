import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
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
}
