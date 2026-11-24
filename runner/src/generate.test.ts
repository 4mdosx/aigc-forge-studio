import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ComfyClient } from './comfy/client.ts'
import { openDatabase, branchOf } from './db.ts'
import { createGeneration, getHeadWorkflow, parseGenerateInput } from './generate.ts'
import type { Runner } from './task/queue.ts'

const GRAPH_BASE = {
  '10': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'old positive' },
    _meta: { title: 'Positive Prompt' },
  },
  '11': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'old negative' },
    _meta: { title: 'Negative Prompt' },
  },
  '12': { class_type: 'KSampler', inputs: { seed: 1 } },
  '13': {
    class_type: 'EmptyLatentImage',
    inputs: { width: 768, height: 1024, batch_size: 1 },
    _meta: { title: 'Empty Latent' },
  },
  '17': {
    class_type: 'LoraLoader',
    inputs: { lora_name: 'old.safetensors', strength_model: 0.8 },
    _meta: { title: 'LoRA' },
  },
  '7': {
    class_type: 'SaveImage',
    inputs: { images: ['5', 0], filename_prefix: 'out' },
  },
}

function testRunner(db = openDatabase(':memory:')): Runner {
  return {
    db,
    clients: [],
    chat: null,
    trainerBaseURL: null,
    timeoutMs: 600_000,
    dataDir: '/tmp/aigc-generate-test',
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    randomSeed: () => 42,
  }
}

// 建一个 workflow + 两个 revision，head 指向第二个，验证接口取的是 head
function seedWorkflow(
  db: ReturnType<typeof openDatabase>,
  name: string,
  api: object,
): { workflowId: string; headVersion: string; oldVersion: string } {
  const workflowId = randomUUID()
  const now = new Date('2026-01-01T00:00:00.000Z').toISOString()
  db.prepare(
    'INSERT INTO workflows (id, name, comfy_path, current_branch, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(workflowId, name, `${name}.json`, 'main', now)
  const oldId = randomUUID()
  const headId = randomUUID()
  db.prepare(
    'INSERT INTO workflow_revisions (id, workflow_id, version, ui_json, api_json, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(oldId, workflowId, 'aaaaaaaa', '{}', JSON.stringify(api), 'old', now)
  db.prepare(
    'INSERT INTO workflow_revisions (id, workflow_id, version, ui_json, api_json, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(headId, workflowId, 'bbbbbbbb', '{}', JSON.stringify(api), 'head', now)
  db.prepare(
    "INSERT INTO workflow_branches (workflow_id, name, head_revision_id) VALUES (?, 'main', ?)",
  ).run(workflowId, headId)
  return { workflowId, headVersion: 'bbbbbbbb', oldVersion: 'aaaaaaaa' }
}

function seedRollConfig(db: ReturnType<typeof openDatabase>): void {
  db.prepare(
    `INSERT INTO config (key, value) VALUES ('roll_config', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(
    JSON.stringify({
      workflowName: 'baseline_v1',
      version: 'aaaaaaaa',
      step: '28',
      workflowPositive: 'masterpiece',
      workflowNegative: 'lowres',
    }),
  )
}

test('parseGenerateInput validates prompt, repeat, loraName and pose rules', () => {
  assert.deepEqual(parseGenerateInput('base', {
    prompt: '1girl',
    repeat: 2,
    loraName: 'style.safetensors',
  }), { prompt: '1girl', repeat: 2, loraName: 'style.safetensors' })
  // loraName 可缺省：沿用 workflow 里绑好的 LoRA
  assert.deepEqual(parseGenerateInput('base', { prompt: '1girl', repeat: 1 }), {
    prompt: '1girl',
    repeat: 1,
    loraName: '',
  })
  assert.deepEqual(parseGenerateInput('cn', {
    prompt: '1girl',
    repeat: 1,
    loraName: 'style.safetensors',
    poseName: 'pose-a',
  }).poseName, 'pose-a')
  assert.throws(
    () => parseGenerateInput('cn', { prompt: 'x', repeat: 1, loraName: 'y' }),
    /poseName is required/,
  )
  assert.throws(
    () => parseGenerateInput('base', {
      prompt: 'x', repeat: 1, loraName: 'y', poseName: 'pose-a',
    }),
    /does not accept poseName/,
  )
  assert.throws(
    () => parseGenerateInput('base', { prompt: 'x', repeat: 0, loraName: 'y' }),
    /repeat must be/,
  )
})

test('getHeadWorkflow reads main head, not the older revision', () => {
  const runner = testRunner()
  const seeded = seedWorkflow(runner.db, 'wf-head-test', GRAPH_BASE)
  const { revision } = getHeadWorkflow(runner.db, 'wf-head-test')
  assert.equal(revision.version, seeded.headVersion)
  assert.notEqual(revision.version, seeded.oldVersion)
  assert.equal(branchOf(runner.db, seeded.workflowId, 'main').head_revision_id, revision.id)
})

test('createGeneration(base) writes job with head version and stores recipe separately', async () => {
  const runner = testRunner()
  seedWorkflow(runner.db, 'baseline_ax4z_lora_v1', GRAPH_BASE)
  seedRollConfig(runner.db)
  const input = parseGenerateInput('base', {
    prompt: '1girl, solo',
    repeat: 3,
    loraName: 'style.safetensors',
  })
  const { jobId } = await createGeneration(runner, 'base', input)
  const job = runner.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown>
  assert.equal(job.kind, 'generate')
  assert.equal(job.status, 'pending')
  assert.equal(job.workflow_name, 'baseline_ax4z_lora_v1')
  assert.equal(job.work_id, null)
  assert.equal(job.label, 'Base')
  const payload = JSON.parse(job.input_json as string) as Record<string, unknown>
  // workflow 自带词优先（2026-11-24）：GRAPH_BASE 的 'old positive' / 'old negative'
  // 压过 roll_config 的 'masterpiece' / 'lowres'
  assert.equal(payload.positive, 'old positive, 1girl, solo')
  assert.equal(payload.negative, 'old negative')
  assert.equal(payload.batch, 3)
  assert.equal(payload.lora_name, 'style.safetensors')
  assert.equal(payload.seed, 'random')
  // 结构化入参不进 job 字典
  assert.equal('poseName' in payload, false)
  assert.equal('repeat' in payload, false)
  assert.equal('prompt' in payload, false)
  // recipe 单独存
  const recipe = runner.db.prepare('SELECT * FROM recipes WHERE job_id = ?').get(jobId) as Record<string, unknown>
  assert.equal(recipe.kind, 'base')
  assert.deepEqual(JSON.parse(recipe.input_json as string), input)
})

test('createGeneration keeps the workflow LoRA when loraName is omitted', async () => {
  const runner = testRunner()
  seedWorkflow(runner.db, 'baseline_ax4z_lora_v1', GRAPH_BASE)
  seedRollConfig(runner.db)
  const input = parseGenerateInput('base', { prompt: '1girl', repeat: 1 })
  const { jobId } = await createGeneration(runner, 'base', input)
  const job = runner.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown>
  const payload = JSON.parse(job.input_json as string) as Record<string, unknown>
  assert.equal(payload.lora_name, 'old.safetensors')
})

test('createGeneration falls back to roll_config when the workflow text is empty', async () => {
  const runner = testRunner()
  const emptyText = structuredClone(GRAPH_BASE) as Record<string, { inputs: Record<string, unknown> }>
  emptyText['10'].inputs.text = '   '
  emptyText['11'].inputs.text = ''
  seedWorkflow(runner.db, 'baseline_ax4z_lora_v1', emptyText)
  seedRollConfig(runner.db)
  const input = parseGenerateInput('base', {
    prompt: '1girl',
    repeat: 1,
    loraName: 'style.safetensors',
  })
  const { jobId } = await createGeneration(runner, 'base', input)
  const job = runner.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown>
  const payload = JSON.parse(job.input_json as string) as Record<string, unknown>
  assert.equal(payload.positive, 'masterpiece, 1girl')
  assert.equal(payload.negative, 'lowres')
})

test('createGeneration(cn) uploads pose files and maps pose_image/depth_image', async () => {  const root = '/tmp/aigc-generate-test'
  mkdirSync(join(root, 'pose'), { recursive: true })
  writeFileSync(join(root, 'pose', 'manifest.json'), JSON.stringify({
    poses: [{
      id: 'pose-a',
      variants: {
        m: { gen: [832, 1216], depth: 'pose/depth.png', bone: 'pose/bone.png' },
      },
    }],
  }))
  writeFileSync(join(root, 'pose', 'depth.png'), 'depth')
  writeFileSync(join(root, 'pose', 'bone.png'), 'bone')

  const uploaded: Array<{ name: string; sub: string }> = []
  const fakeClient = {
    uploadBytes: async (_bytes: Uint8Array, name: string, sub: string) => {
      uploaded.push({ name, sub })
    },
  } as unknown as ComfyClient
  const runner = testRunner()
  runner.clients = [fakeClient]
  const cnGraph = {
    '10': {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'old' },
      _meta: { title: 'Positive' },
    },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'old' },
      _meta: { title: 'Negative' },
    },
    '4': {
      class_type: 'KSampler',
      inputs: { seed: 1, denoise: 0.5 },
      _meta: { title: 'Base KSampler' },
    },
    '2': {
      class_type: 'LoraLoader',
      inputs: { lora_name: 'old', strength_model: 1 },
      _meta: { title: 'Style LoRA (strength 0 = off)' },
    },
    '21': {
      class_type: 'LoadImage',
      inputs: { image: 'old.png' },
      _meta: { title: 'Skeleton Image' },
    },
    '25': {
      class_type: 'LoadImage',
      inputs: { image: 'old.png' },
      _meta: { title: 'Depth Image' },
    },
    '43': {
      class_type: 'RepeatLatentBatch',
      inputs: { amount: 1 },
      _meta: { title: 'Repeat Latent' },
    },
    '50': {
      class_type: 'EmptyLatentImage',
      inputs: { width: 832, height: 1216, batch_size: 1 },
      _meta: { title: 'Empty Latent' },
    },
    '8': {
      class_type: 'SaveImage',
      inputs: { images: ['5', 0], filename_prefix: 'out' },
      _meta: { title: 'Save' },
    },
  }
  seedWorkflow(runner.db, 'base_ax4z_lora_cn_1', cnGraph)
  seedRollConfig(runner.db)
  const input = parseGenerateInput('cn', {
    prompt: '1girl',
    repeat: 2,
    loraName: 'style.safetensors',
    poseName: 'pose-a',
  })
  const { jobId } = await createGeneration(runner, 'cn', input)
  const job = runner.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown>
  const payload = JSON.parse(job.input_json as string) as Record<string, unknown>
  assert.equal(payload.pose_image, 'generate/pose-a/bone.png')
  assert.equal(payload.depth_image, 'generate/pose-a/depth.png')
  assert.equal(payload.width, 832)
  assert.equal(payload.height, 1216)
  assert.equal(payload.batch, 2)
  assert.deepEqual(uploaded, [
    { name: 'depth.png', sub: 'generate/pose-a' },
    { name: 'bone.png', sub: 'generate/pose-a' },
  ])
})
