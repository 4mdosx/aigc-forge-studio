import assert from 'node:assert/strict'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { test } from 'node:test'

import { ComfyClient } from '../comfy/client.ts'
import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'
import { mountSystem } from './system.ts'

// 桩：训练机 /gpu + ComfyUI /system_stats + /free 放在同一台假服务上
let freeCalls = 0
let freed = false
const stub = new Hono()
stub.get('/gpu', (c) =>
  c.json({
    checkedAt: '2026-01-01T00:00:00.000Z',
    gpus: [
      {
        index: 0,
        name: 'NVIDIA GeForce RTX 3080',
        memTotalMiB: 10240,
        memUsedMiB: 9216,
        memFreeMiB: 1024,
        utilization: 97,
        temperatureC: 74,
        powerW: 320,
      },
    ],
    processes: [{ pid: 1234, name: 'python.exe', usedMiB: 8800 }],
  }),
)
stub.get('/system_stats', (c) =>
  c.json({
    system: { ram_total: 17_000_000_000, ram_free: freed ? 9_700_000_000 : 2_100_000_000 },
    devices: [
      {
        name: 'cuda:0 NVIDIA GeForce RTX 3080',
        vram_total: 10_700_000_000,
        vram_free: freed ? 9_000_000_000 : 21_000_000,
        torch_vram_total: 0,
        torch_vram_free: 0,
      },
    ],
  }),
)
stub.post('/free', (c) => {
  freeCalls += 1
  freed = true
  return c.json({})
})

function appWithSystem(runner: Runner): Hono {
  const app = new Hono()
  app.onError((err, c) => {
    const status = err instanceof RunnerError ? err.status : 500
    return c.json({ error: err.message }, status as 400)
  })
  mountSystem(app, runner)
  return app
}

function runnerOf(baseURL: string | null): Runner {
  return {
    db: null as never,
    clients: baseURL ? [new ComfyClient(baseURL)] : [],
    chat: null,
    trainerBaseURL: baseURL,
    timeoutMs: 600_000,
    dataDir: '/tmp/aigc-runner-test-data',
    now: () => new Date(),
    randomSeed: () => 42,
  }
}

async function withStub(fn: (baseURL: string) => Promise<void>): Promise<void> {
  const server = serve({ fetch: stub.fetch, hostname: '127.0.0.1', port: 0 })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    const addr = server.address()
    if (addr === null || typeof addr === 'string') throw new Error('no port')
    await fn(`http://127.0.0.1:${addr.port}`)
  } finally {
    server.close()
  }
}

test('GET /system/gpu merges trainer nvidia-smi and ComfyUI stats', async () => {
  freed = false
  await withStub(async (base) => {
    const app = appWithSystem(runnerOf(base))
    const res = await app.request('/system/gpu')
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      gpu: { gpus: { memUsedMiB: number }[]; processes: { pid: number }[] } | null
      gpuError: string | null
      comfy: { vramFree: number; ramFree: number; deviceName: string } | null
      comfyError: string | null
    }
    assert.equal(body.gpuError, null)
    assert.equal(body.gpu?.gpus[0]?.memUsedMiB, 9216)
    assert.equal(body.gpu?.processes[0]?.pid, 1234)
    assert.equal(body.comfyError, null)
    assert.equal(body.comfy?.vramFree, 21_000_000)
    assert.match(body.comfy?.deviceName ?? '', /RTX 3080/)
  })
})

test('GET /system/gpu degrades when trainer is unreachable', async () => {
  const runner = runnerOf('http://127.0.0.1:1')
  const app = appWithSystem(runner)
  const res = await app.request('/system/gpu')
  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    gpu: unknown
    gpuError: string | null
    comfy: unknown
    comfyError: string | null
  }
  assert.equal(body.gpu, null)
  assert.ok(body.gpuError)
  // ComfyUI 也指向同一条死端口，两边都降级但接口本身不炸
  assert.equal(body.comfy, null)
  assert.ok(body.comfyError)
})

test('POST /system/comfy/free unloads models and reports before/after', async () => {
  freed = false
  freeCalls = 0
  await withStub(async (base) => {
    const app = appWithSystem(runnerOf(base))
    const res = await app.request('/system/comfy/free', { method: 'POST' })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      before: { vramFree: number }
      after: { vramFree: number }
    }
    assert.equal(freeCalls, 1)
    assert.equal(body.before.vramFree, 21_000_000)
    assert.equal(body.after.vramFree, 9_000_000_000)
  })
})

test('POST /system/comfy/free needs a ComfyUI client', async () => {
  const app = appWithSystem(runnerOf(null))
  const res = await app.request('/system/comfy/free', { method: 'POST' })
  assert.equal(res.status, 503)
})
