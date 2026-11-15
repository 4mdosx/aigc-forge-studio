import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'

export interface Fixture {
  url: string
  buffer: Buffer
  sha256: string
  /** 已发生的 Range 请求数（续传断言用） */
  rangeRequests: number
  /** 可运行时切换的失败开关 */
  fail: boolean
  /** 暂停发流（连接保持但不写数据，测停滞超时） */
  paused: boolean
  close: () => Promise<void>
}

export interface FixtureOptions {
  /** 每写一块 sleep 的毫秒数；0 = 不限速 */
  dripMs?: number
  /** 每块字节数 */
  chunkSize?: number
  /** 初始 fail 开关 */
  fail?: boolean
  /** 拒绝 Range 请求（测降级为整下） */
  noRange?: boolean
}

// 本地 HTTP fixture：固定内容 + Range 支持，用于下载管理器测试
export async function startFixture(
  bytes: number,
  options: FixtureOptions = {},
): Promise<Fixture> {
  const buffer = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i += 1) {
    buffer[i] = (i * 31 + 7) % 251
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const chunkSize = options.chunkSize ?? 64 * 1024
  const dripMs = options.dripMs ?? 0
  const state = { fail: options.fail ?? false, paused: false }
  const server: Server = createServer((req, res) => {
    if (state.fail) {
      res.writeHead(500)
      res.end('boom')
      return
    }
    const range = req.headers.range
    const supportsRange = !options.noRange
    if (range && supportsRange) {
      const match = /^bytes=(\d+)-$/.exec(range)
      if (match) {
        const start = Number(match[1])
        res.writeHead(206, {
          'content-type': 'application/octet-stream',
          'content-length': buffer.length - start,
          'accept-ranges': 'bytes',
        })
        void writeBody(res, buffer.subarray(start))
        return
      }
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': buffer.length,
      'accept-ranges': supportsRange ? 'bytes' : 'none',
    })
    void writeBody(res, buffer)
  })
  let rangeRequests = 0
  server.on('request', (req) => {
    if (req.headers.range) rangeRequests += 1
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('fixture server failed to bind')
  }
  return {
    url: `http://127.0.0.1:${address.port}/file.bin`,
    buffer,
    sha256,
    get fail() {
      return state.fail
    },
    set fail(v: boolean) {
      state.fail = v
    },
    get paused() {
      return state.paused
    },
    set paused(v: boolean) {
      state.paused = v
    },
    get rangeRequests() {
      return rangeRequests
    },
    close: () =>
      new Promise((ok, err) => server.close((e) => (e ? err(e) : ok()))),
  }

  async function writeBody(
    res: import('node:http').ServerResponse,
    data: Buffer,
  ): Promise<void> {
    for (let i = 0; i < data.length; i += chunkSize) {
      if (res.destroyed) return
      // 暂停时挂住不发数据，连接保持——客户端侧表现为停滞
      while (state.paused && !res.destroyed) await sleep(50)
      if (res.destroyed) return
      res.write(data.subarray(i, i + chunkSize))
      if (dripMs > 0) await sleep(dripMs)
    }
    res.end()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((ok) => setTimeout(ok, ms))
}
