import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'

// pose id → 上传骨架/深度图 → 返回可直接并进 payload 的覆盖项。
// 两个调用方共用：快速出图（/generate/cn）与按 work 跑（/works/:name/run）。
// 上传路径固定 generate/<poseId>，重名覆盖，重复调用幂等。

interface PoseVariant {
  gen?: number[]
  depth: string
  bone: string
}

export async function poseOverrides(
  runner: Runner,
  poseName: string,
): Promise<Record<string, unknown>> {
  if (poseName === '') throw new RunnerError('poseName is required')
  const variant = poseVariant(runner, poseName)
  const client = runner.clients[0]
  if (!client) throw new RunnerError('no ComfyUI instance')
  const sub = `generate/${poseName}`
  const read = (rel: string, label: string): Uint8Array => {
    const path = join(runner.dataDir, rel)
    if (!existsSync(path))
      throw new RunnerError(`pose ${label} file missing: ${rel}`, 404)
    return new Uint8Array(readFileSync(path))
  }
  await client.uploadBytes(read(variant.depth, 'depth'), 'depth.png', sub)
  await client.uploadBytes(read(variant.bone, 'bone'), 'bone.png', sub)
  const gen = variant.gen
  if (!gen || gen.length < 2) throw new RunnerError('pose has no gen size')
  return {
    pose_image: `${sub}/bone.png`,
    depth_image: `${sub}/depth.png`,
    width: gen[0],
    height: gen[1],
  }
}

export function poseVariant(runner: Runner, poseName: string): PoseVariant {
  const manifestPath = join(runner.dataDir, 'pose', 'manifest.json')
  if (!existsSync(manifestPath))
    throw new RunnerError('data/pose/manifest.json missing', 404)
  let manifest: {
    poses?: Array<{ id: string; variants?: Record<string, PoseVariant> }>
  }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest
  } catch (err) {
    throw new RunnerError(
      `invalid manifest: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const entry = (manifest.poses ?? []).find((p) => p.id === poseName)
  if (!entry) throw new RunnerError(`pose ${poseName} not in manifest`, 404)
  const variant = Object.values(entry.variants ?? {}).find(
    (v) => v && v.gen && v.depth && v.bone,
  )
  if (!variant) throw new RunnerError(`pose ${poseName} has no usable variant`, 404)
  return variant
}
