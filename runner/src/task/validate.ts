import { PNG } from 'pngjs'

import type { ComfyClient } from '../comfy/client.ts'
import { viewTarget } from '../path.ts'
import { RunnerError } from '../errors.ts'

// 输出退化校验（2026-11-14）：SDPose 对极端姿势会静默产出近空图
//（全黑或仅零星杂点）。判据 = 与主色偏离的像素占比（RGB 量化到 32 级分桶）。
// 实测标定：合格骨架 ≈ 0.52%，失败骨架（4 杂点）≈ 0.027%，正常生图 ≈ 26%+，
// 阈值 0.001（0.1%）两侧均有 ≥3 倍裕量。仅校验 PNG，其余格式跳过。
export const MIN_DEVIATION_RATIO = 0.001

export function isDegeneratePng(bytes: Uint8Array): boolean {
  let png: PNG
  try {
    png = PNG.sync.read(Buffer.from(bytes))
  } catch {
    return true
  }
  const data = png.data
  const pixels = data.length / 4
  if (pixels === 0) return true
  const buckets = new Map<number, number>()
  for (let i = 0; i < data.length; i += 4) {
    const key = ((data[i]! >> 5) << 10) | ((data[i + 1]! >> 5) << 5) | (data[i + 2]! >> 5)
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  let modal = 0
  for (const count of buckets.values()) {
    if (count > modal) modal = count
  }
  return 1 - modal / pixels < MIN_DEVIATION_RATIO
}

// 返回退化的最终输出文件路径列表；只处理 output/ 下的 .png
export async function findDegenerateOutputs(
  client: ComfyClient,
  paths: string[],
): Promise<string[]> {
  const bad: string[] = []
  for (const path of paths) {
    if (!path.toLowerCase().endsWith('.png')) continue
    let target: ReturnType<typeof viewTarget>
    try {
      target = viewTarget(path)
    } catch {
      continue
    }
    if (target.type !== 'output') continue
    let bytes: Uint8Array
    try {
      ;({ bytes } = await client.viewFile(target.type, target.subfolder, target.filename))
    } catch (err) {
      throw new RunnerError(
        `cannot fetch output for validation: ${path} (${err instanceof Error ? err.message : String(err)})`,
      )
    }
    if (isDegeneratePng(bytes)) bad.push(path)
  }
  return bad
}
