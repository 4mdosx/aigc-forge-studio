import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'

import type { ComfyClient } from '../comfy/client.ts'
import { openDatabase } from '../db.ts'
import type { Runner } from '../task/queue.ts'
import {
  approveOutput,
  listOutputAssets,
  outputDetail,
  outputId,
  rejectOutput,
} from './gallery.ts'
import { generationFromPng, readPngText } from './metadata.ts'

const NOW = 1_800_000_000_000

// 造一张带 tEXt prompt 的 PNG（pngjs 不写 text，手工拼 chunk）
function pngWithPrompt(prompt: object): Buffer {
  const width = 2
  const height = 2
  const raw = Buffer.concat(
    Array.from({ length: height }, () => Buffer.concat([
      Buffer.from([0]),
      Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
    ])),
  )
  const chunks: Buffer[] = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', (() => {
      const b = Buffer.alloc(13)
      b.writeUInt32BE(width, 0)
      b.writeUInt32BE(height, 4)
      b[8] = 8
      b[9] = 2
      return b
    })()),
    chunk('tEXt', Buffer.concat([
      Buffer.from('prompt\0', 'latin1'),
      Buffer.from(JSON.stringify(prompt), 'utf8'),
    ])),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]
  return Buffer.concat(chunks)
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1)
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeRunner(bytes: Buffer): { runner: Runner; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aigc-output-'))
  mkdirSync(join(dir, 'output'), { recursive: true })
  const client = {
    baseURL: 'http://comfy.test:8188',
    viewFile: async () => ({ bytes: new Uint8Array(bytes), contentType: 'image/png' }),
  } as unknown as ComfyClient
  const runner = {
    db: openDatabase(':memory:'),
    clients: [client],
    chat: null,
    trainerBaseURL: null,
    dataDir: dir,
    timeoutMs: 600_000,
    now: () => new Date(NOW),
    randomSeed: () => 42,
  } as unknown as Runner
  return { runner, dir }
}

function seedJobs(db: Runner['db']): void {
  const insert = db.prepare(
    `INSERT INTO jobs
       (id, kind, status, workflow_name, task, input_json, output_path, comfy_base_url, created_at)
     VALUES (?, 'generate', 'completed', ?, ?, ?, ?, ?, ?)`,
  )
  insert.run(
    'job-cn', 'base_ax4z_lora_cn_1', 'gen-cn-test',
    JSON.stringify({ seed: 123, denoise: 1 }),
    JSON.stringify(['output/2026-11-21/gen-cn-test/character_00001_.png', 'output/2026-11-21/gen-cn-test/character_00002_.png']),
    'http://comfy.test:8188', NOW,
  )
  insert.run(
    'job-base', 'baseline_ax4z_lora_v1', 'gen-base-test',
    '{}', 'output/2026-11-21/gen-base-test/sdxl_simple_00001_.png',
    'http://comfy.test:8188', NOW - 1000,
  )
  // 不在白名单的 workflow 不能进产出图库
  insert.run(
    'job-old', 'character_v2', 'old', '{}',
    'output/2026-11-20/old/character_00001_.png',
    'http://comfy.test:8188', NOW - 2000,
  )
  db.prepare(`INSERT INTO recipes (job_id, kind, input_json, created_at) VALUES (?, ?, ?, ?)`)
    .run('job-cn', 'cn', JSON.stringify({ prompt: '1girl', repeat: 2, loraName: 'style.safetensors', poseName: 'standing005' }), NOW)
}

const PROMPT = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'ax4z.safetensors' } },
  '2': { class_type: 'LoraLoader', inputs: { lora_name: 'style.safetensors', strength_model: 0.8 } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: '1girl, masterpiece' } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: 'lowres, logo' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 1216, height: 832 } },
  '6': {
    class_type: 'KSampler',
    inputs: {
      seed: 2813666172, steps: 28, cfg: 5, sampler_name: 'euler',
      scheduler: 'normal', denoise: 1, positive: ['3', 0], negative: ['4', 0],
    },
  },
}

test('metadata：读 tEXt prompt 并压成生成信息摘要', () => {
  const bytes = pngWithPrompt(PROMPT)
  assert.deepEqual(Object.keys(readPngText(bytes)), ['prompt'])
  const gen = generationFromPng(bytes)
  assert.equal(gen.prompt && Object.keys(gen.prompt).length, 6)
  assert.equal(gen.info.checkpoint, 'ax4z.safetensors')
  assert.deepEqual(gen.info.loras, [{ name: 'style.safetensors', strength: 0.8 }])
  assert.equal(gen.info.positive, '1girl, masterpiece')
  assert.equal(gen.info.negative, 'lowres, logo')
  assert.equal(gen.info.seed, 2813666172)
  assert.equal(gen.info.denoise, 1)
  assert.equal(gen.info.width, 1216)
  assert.equal(gen.info.height, 832)
})

test('metadata：无 prompt 块时返回空摘要，不抛错', () => {
  const gen = generationFromPng(pngWithPrompt({}))
  assert.equal(gen.info.seed, null)
  assert.equal(gen.info.positive, '')
})

test('产出图库：只列新链路生成图，多图展开，默认全待审 + 状态计数', () => {
  const { runner } = makeRunner(pngWithPrompt(PROMPT))
  try {
    seedJobs(runner.db)
    const page = listOutputAssets(runner.db, { offset: 0, size: 60 })
    assert.equal(page.total, 3) // 2 张 cn + 1 张 base；old 不在白名单
    assert.deepEqual(page.counts, { pending: 3, approved: 0, rejected: 0 })
    assert.deepEqual(page.workflows, ['base_ax4z_lora_cn_1', 'baseline_ax4z_lora_v1'])
    const paths = page.items.map((item) => item.path)
    assert.ok(paths.includes('output/2026-11-21/gen-cn-test/character_00001_.png'))
    assert.ok(paths.includes('output/2026-11-21/gen-cn-test/character_00002_.png'))
    assert.equal(page.items[0].id, outputId(page.items[0].path))
  } finally {
    runner.db.close()
  }
})

test('产出图库：详情带 recipe 与 metadata 摘要', async () => {
  const { runner } = makeRunner(pngWithPrompt(PROMPT))
  try {
    seedJobs(runner.db)
    const detail = await outputDetail(runner, outputId('output/2026-11-21/gen-cn-test/character_00001_.png'))
    assert.equal(detail.recipe?.kind, 'cn')
    assert.deepEqual(detail.recipe?.input, {
      prompt: '1girl', repeat: 2, loraName: 'style.safetensors', poseName: 'standing005',
    })
    assert.equal(detail.generation.info.checkpoint, 'ax4z.safetensors')
    assert.equal(detail.generation.info.seed, 2813666172)
    assert.equal(detail.imageUrl, `/output/image/${outputId(detail.item.path)}`)
    // 没有 recipe 的任务降级到 job input_json
    const base = await outputDetail(runner, outputId('output/2026-11-21/gen-base-test/sdxl_simple_00001_.png'))
    assert.equal(base.recipe, null)
    assert.deepEqual(base.jobInput, {})
  } finally {
    runner.db.close()
  }
})

test('产出图库：通过复制字节到本地 data/output 并标记 approved；拒绝只改状态', async () => {
  const { runner, dir } = makeRunner(pngWithPrompt(PROMPT))
  try {
    seedJobs(runner.db)
    const id = outputId('output/2026-11-21/gen-cn-test/character_00001_.png')
    const approved = await approveOutput(runner, id)
    assert.equal(approved.status, 'approved')
    assert.ok(approved.reviewedAt)
    const local = join(dir, 'output/2026-11-21/gen-cn-test/character_00001_.png')
    assert.ok(existsSync(local))
    assert.deepEqual(readFileSync(local), pngWithPrompt(PROMPT))
    // 幂等：再点一次不报错、状态不变
    assert.equal((await approveOutput(runner, id)).status, 'approved')
    assert.deepEqual(listOutputAssets(runner.db, { offset: 0, size: 60 }).counts, {
      pending: 2, approved: 1, rejected: 0,
    })
    // 拒绝另一张
    const id2 = outputId('output/2026-11-21/gen-cn-test/character_00002_.png')
    assert.equal(rejectOutput(runner, id2).status, 'rejected')
    assert.deepEqual(listOutputAssets(runner.db, { offset: 0, size: 60 }).counts, {
      pending: 1, approved: 1, rejected: 1,
    })
    // status 过滤
    const onlyApproved = listOutputAssets(runner.db, { status: 'approved', offset: 0, size: 60 })
    assert.equal(onlyApproved.total, 1)
    assert.equal(onlyApproved.items[0].id, id)
  } finally {
    runner.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
