import type { Hono } from 'hono'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { branchOf, revisionById, workflowByName } from '../db.ts'
import { RunnerError } from '../errors.ts'
import { quickPayload, loraOverride, workflowForPose } from '../quickGenerate.ts'
import { readRollConfig } from '../rollConfig.ts'
import { createTask } from '../task/records.ts'
import type { Runner } from '../task/queue.ts'
import type { AdapterMap } from '../workflow/binding.ts'
import type { Prompt } from '../workflow/graph.ts'
import { linkOf, readAdapterMap, resolveAdapter, workByName } from '../work/works.ts'
import { jsonObject, taskJson } from './request.ts'

const QUICK_WORK = 'baseline'

interface PoseVariant {
  gen?: number[]
  depth?: string
  bone?: string
}

export function mountQuick(app: Hono, runner: Runner): void {
  app.post('/quick/generate', async (c) => {
    const body = await jsonObject(c.req)
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (prompt === '') throw new RunnerError('prompt is required')
    const poseId = typeof body.poseId === 'string' ? body.poseId.trim() : ''
    const loraName = typeof body.loraName === 'string' ? body.loraName.trim() : ''

    const rollConfig = readRollConfig(runner.db)
    // 固定 prompt 取自 roll_config，但版本走各自 workflow 的 main head：
    // roll_config.version 是 dice 的锁定版本，套到 quick 的两个工作流上会拿错版本（如旧的 batch=4）。
    const workflowName = workflowForPose(poseId)
    const work = workByName(runner.db, QUICK_WORK)
    const workflow = workflowByName(runner.db, workflowName)
    const revision = revisionFor(runner, workflow.id)
    const link = linkOf(runner.db, work.id, workflow.id)
    if (!link) throw new RunnerError('workflow is not in this work')
    const history = runner.db
      .prepare(
        `SELECT version, created_at FROM workflow_revisions
         WHERE workflow_id = ? ORDER BY created_at`,
      )
      .all(workflow.id) as Array<{ version: string; created_at: string }>
    const resolved = resolveAdapter(readAdapterMap(link.adapter_json), revision.version, history)
    if (!resolved.adapter) throw new RunnerError('workflow version has no adapter')

    const overrides = {
      ...(await poseOverrides(runner, poseId, resolved.adapter)),
      ...(loraName === '' ? {} : loraOverride(resolved.adapter, loraName)),
    }
    const payload = quickPayload(
      JSON.parse(revision.api_json) as Prompt,
      resolved.adapter,
      prompt,
      rollConfig,
      overrides,
    )
    const task = createTask(
      runner.db,
      {
        task: 'quick',
        workName: work.name,
        workflowName: workflow.name,
        payload,
      },
      runner.now(),
      runner.randomSeed,
      runner.dataDir,
    )
    return c.json(taskJson(runner.db, task), 201)
  })
}

async function poseOverrides(
  runner: Runner,
  poseId: string,
  adapter: AdapterMap,
): Promise<Record<string, unknown>> {
  if (poseId === '') return {}
  const variant = poseVariant(runner, poseId)
  const takesPose = Boolean(adapter.inputs.pose_image || adapter.inputs.depth_image)
  const overrides: Record<string, unknown> = {}
  const gen = variant.gen
  if (gen && gen.length >= 2) {
    overrides.width = gen[0]
    overrides.height = gen[1]
  }
  if (!takesPose) return overrides
  const client = runner.clients[0]
  if (!client) throw new RunnerError('no ComfyUI instance')
  const sub = `quick/${poseId}`
  const readPoseFile = (rel: string, label: string): Uint8Array => {
    const path = join(runner.dataDir, rel)
    if (!existsSync(path)) throw new RunnerError(`pose ${label} file missing: ${rel}`, 404)
    return new Uint8Array(readFileSync(path))
  }
  await client.uploadBytes(readPoseFile(variant.depth as string, 'depth'), 'depth.png', sub)
  await client.uploadBytes(readPoseFile(variant.bone as string, 'bone'), 'bone.png', sub)
  overrides.pose_image = `${sub}/bone.png`
  overrides.depth_image = `${sub}/depth.png`
  return overrides
}

function poseVariant(runner: Runner, poseId: string): PoseVariant {
  const manifestPath = join(runner.dataDir, 'pose', 'manifest.json')
  if (!existsSync(manifestPath)) throw new RunnerError('data/pose/manifest.json missing', 404)
  let entry: { variants?: Record<string, PoseVariant> } | null = null
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      poses?: Array<{ id: string; variants?: Record<string, PoseVariant> }>
    }
    entry = (manifest.poses ?? []).find((pose) => pose.id === poseId) ?? null
  } catch (err) {
    throw new RunnerError(`invalid manifest: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!entry) throw new RunnerError(`pose ${poseId} not in manifest`, 404)
  const variant = Object.values(entry.variants ?? {}).find((item) => item.gen && item.depth && item.bone)
  if (!variant) throw new RunnerError(`pose ${poseId} has no usable variant`, 404)
  return variant
}

function revisionFor(runner: Runner, workflowId: string) {
  return revisionById(runner.db, branchOf(runner.db, workflowId, 'main').head_revision_id)
}
