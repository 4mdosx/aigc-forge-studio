#!/usr/bin/env node
// 把「自绘骨架 + 同坐标合成深度」那批姿态登记进 data/pose/manifest.json。
//
// 为什么必须登记：快速出图（quick-generate）选 pose 走 GET /data/poses，
// generate.ts 再按 manifest 里的 bone/depth/gen 上传并发起任务。manifest 里没有
// 这批姿态，就只能用 pose 库里那 467 张 —— 而那是外部 3D 写实人体渲染的 depth
// （八头身、带地面灰带），会把画风往写实拽，且 165 张 standing 里没有一个正面直立。
//
// 登记的只有「骨架与深度成对、且都是自绘坐标系」的目录：
//   data/pose/synthetic/<variant>/{bone,depth}.png   5 个站姿
//   data/pose/weapon/<hash>/{bone,depth}.png         6 个持械姿态（10 组里去掉 4 组：
//                                                    1 组骨架断裂，3 组未验证）
//
// 幂等：先删掉 manifest 里 source === 'synthetic' 的旧条目，再整体重插。
//
// 用法：
//   node scripts_and_tools/register_synthetic_poses.mjs --dry-run
//   node scripts_and_tools/register_synthetic_poses.mjs

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(REPO, 'data', 'pose', 'manifest.json')
const DRY = process.argv.includes('--dry-run')

const SOURCE = 'synthetic'
const GROUP = 'mecha'
const CANVAS = '8321216'
const GEN = [832, 1216]

// 站姿：5 个变体都在 FINAL-20261124 里验证过全身入画
const STANDS = [
  { dir: 'stand-a', name: '正面直立', tags: ['standing', 'full body', 'front view', 'arms at sides'] },
  { dir: 'stand-3q', name: '四分之三侧身', tags: ['standing', 'full body', 'three-quarter view'] },
  { dir: 'stand-hands', name: '双手交握身前', tags: ['standing', 'full body', 'clasped hands'] },
  { dir: 'stand-hip', name: '一手扶胯', tags: ['standing', 'full body', 'hand on hip', 'contrapposto'] },
  { dir: 'stand-open', name: '双臂张开', tags: ['standing', 'full body', 'arms spread'] },
]

// 持械：hash 来自 FINALWEAPON-20261124 / WEAPON-20261124 实际用过的 6 组
const WEAPONS = [
  { hash: '20261120-154611-571b', name: '垂手持械', tags: ['standing', 'full body', 'holding weapon at side'] },
  { hash: '20261124-110623-3658', name: '立姿持械', tags: ['standing', 'full body', 'weapon resting'] },
  { hash: '20261124-110648-dca5', name: '架械外抬', tags: ['standing', 'full body', 'weapon braced outward'] },
  { hash: '20261124-110754-e29d', name: '双手拄械', tags: ['standing', 'full body', 'both hands on weapon'] },
  { hash: '20261124-121343-5a3f', name: '垂臂持械', tags: ['standing', 'full body', 'weapon lowered'] },
  { hash: '20261124-121412-6c2a', name: '单臂前伸持械', tags: ['standing', 'full body', 'weapon held forward'] },
]

function entry({ id, name, tags, bone, depth }) {
  // manifest 里的路径相对 ComfyUI input 根，磁盘正本在 data/ 下
  if (!existsSync(join(REPO, 'data', bone))) throw new Error(`missing data/${bone}`)
  if (!existsSync(join(REPO, 'data', depth))) throw new Error(`missing data/${depth}`)
  return {
    id,
    poseName: GROUP,
    name,
    nsfw: false,
    description: '自绘 COCO-18 骨架 + 同坐标系合成深度，无 3D 写实人体先验',
    source: SOURCE,
    defects: [],
    tags,
    guide: { view: [], shot: ['full body'], framing: [] },
    enabled: true,
    variants: {
      [CANVAS]: { aspect: 'portrait', gen: GEN, bone, depth },
    },
  }
}

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const poses = Array.isArray(manifest.poses) ? manifest.poses : []

  const added = [
    ...STANDS.map((s) =>
      entry({
        id: `synth-${s.dir}`,
        name: s.name,
        tags: s.tags,
        bone: `pose/synthetic/${s.dir}/bone.png`,
        depth: `pose/synthetic/${s.dir}/depth.png`,
      }),
    ),
    ...WEAPONS.map((w) =>
      entry({
        id: `wp-${w.hash}`,
        name: w.name,
        tags: w.tags,
        bone: `pose/weapon/${w.hash}/bone.png`,
        depth: `pose/weapon/${w.hash}/depth.png`,
      }),
    ),
  ]

  const kept = poses.filter((p) => p.source !== SOURCE)
  const next = [...kept, ...added]

  const poseNames = { ...(manifest.poseNames ?? {}) }
  const groupTotal = added.length
  poseNames[GROUP] = { total: groupTotal, enabled: groupTotal }

  const out = {
    ...manifest,
    poses: next,
    poseNames,
  }
  out.total = { ...(manifest.total ?? {}), poses: next.length }
  out.enabled = {
    ...(manifest.enabled ?? {}),
    poses: next.filter((p) => p.enabled !== false).length,
  }

  console.log(`manifest: ${poses.length} -> ${next.length} poses（+${added.length} 自绘）`)
  for (const a of added) console.log(`  ${a.id}  ${a.name}  ${a.variants[CANVAS].bone}`)

  if (DRY) {
    console.log('dry-run：未写入')
    return
  }
  writeFileSync(MANIFEST, `${JSON.stringify(out, null, 2)}\n`)
  console.log(`已写入 ${MANIFEST}`)
}

main()
