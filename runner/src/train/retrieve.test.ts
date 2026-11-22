import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { test } from 'node:test'

import {
  artifactCandidates,
  readManifest,
  retrievedManifest,
  retrieveArtifacts,
  safeJobName,
} from './retrieve.ts'

const epoch1 = 'demo-job-000001.safetensors'
const final = 'demo-job.safetensors'
const bytes = Buffer.from('fake safetensors bytes, small enough to stream')

const uploaded: string[] = []
const stub = new Hono()
// Hono 的 GET 路由自动响应 HEAD（trainer 真实 /files 也只有 GET）
stub.get('/files', (c) => {
  const path = c.req.query('path') ?? ''
  if (path !== `demo-job/output/${epoch1}` && path !== `demo-job/output/${final}`) {
    return c.text('not found', 404)
  }
  return c.body(bytes)
})
stub.post('/upload', async (c) => {
  const buf = Buffer.from(await c.req.arrayBuffer())
  uploaded.push(c.req.query('path') ?? '')
  return c.json({ path: '', size: buf.byteLength, sha256: 'a'.repeat(64) })
})

async function withStub(fn: (base: string, dataDir: string) => Promise<void>): Promise<void> {
  const server = serve({ fetch: stub.fetch, hostname: '127.0.0.1', port: 0 })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    const addr = server.address()
    if (addr === null || typeof addr === 'string') throw new Error('no port')
    await fn(`http://127.0.0.1:${addr.port}`, mkdtempSync(join(tmpdir(), 'retrieve-')))
  } finally {
    server.close()
  }
}

test('artifactCandidates 按 saveEveryNEpochs 枚举 epoch，final 收尾', () => {
  assert.deepEqual(artifactCandidates({ maxTrainEpochs: 3, saveEveryNEpochs: 1 }, 'x'), [
    'x-000001.safetensors',
    'x-000002.safetensors',
    'x-000003.safetensors',
    'x.safetensors',
  ])
  assert.deepEqual(artifactCandidates({ maxTrainEpochs: 4, saveEveryNEpochs: 2 }, 'x'), [
    'x-000002.safetensors',
    'x-000004.safetensors',
    'x.safetensors',
  ])
})

test('safeJobName 拒绝路径穿越', () => {
  assert.equal(safeJobName('ok-name_1.2'), 'ok-name_1.2')
  assert.throws(() => safeJobName('../evil'))
  assert.throws(() => safeJobName('a/b'))
  assert.throws(() => safeJobName(42))
})

test('回程：拉回权重 + 部署 + 写 manifest，且幂等判断生效', async () => {
  await withStub(async (base, dataDir) => {
    uploaded.length = 0
    const manifest = await retrieveArtifacts({
      trainerBaseURL: base,
      dataDir,
      jobId: 'job-1',
      name: 'demo-job',
      params: { baseModel: 'checkpoints/pdv10.safetensors', maxTrainEpochs: 1 },
    })
    assert.equal(manifest.jobId, 'job-1')
    assert.deepEqual(manifest.files.map((f) => f.file), [epoch1, final])
    assert.equal(manifest.baseModel, 'checkpoints/pdv10.safetensors')
    assert.equal(manifest.trigger, null)
    assert.equal(readFileSync(join(dataDir, 'lora', 'demo-job', epoch1)).length, bytes.length)
    assert.deepEqual(uploaded, [`loras/${epoch1}`, `loras/${final}`])
    const onDisk = await readManifest(dataDir, 'demo-job')
    assert.equal(onDisk?.files.length, 2)

    // 同 jobId + 文件都在 → 已回程
    assert.ok(await retrievedManifest(dataDir, 'job-1', 'demo-job'))
    // 换 jobId → 重新回程
    assert.equal(await retrievedManifest(dataDir, 'job-2', 'demo-job'), null)
    // 文件大小被改动 → 重新回程
    writeFileSync(join(dataDir, 'lora', 'demo-job', final), 'truncated')
    assert.equal(await retrievedManifest(dataDir, 'job-1', 'demo-job'), null)
  })
})
