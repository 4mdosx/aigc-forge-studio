#!/usr/bin/env node
// 机设配方库出图器。
//
//   node scripts_and_tools/mech_design.mjs --list
//   node scripts_and_tools/mech_design.mjs --design knight
//   node scripts_and_tools/mech_design.mjs --design knight --palette olive --seeds 7601,7602
//   node scripts_and_tools/mech_design.mjs --all --hires
//   node scripts_and_tools/mech_design.mjs --design flight --pose data/pose/synthetic/stand-hip/bone.png
//
// 读 data/mech/designs.json（style / negative / armor / palette / defaults），
// 拼 positive 后转调 cn_gloss_probe.mjs（单遍）或 hires_face_probe.mjs（--hires）。
// 加新机设只要往 JSON 的 designs 里加一条，不用改这个脚本。

import { spawn } from 'node:child_process'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(ROOT, 'data/mech/designs.json')

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return dflt
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const has = (n) => process.argv.includes(`--${n}`)

const lib = JSON.parse(readFileSync(LIB, 'utf8'))
const designs = lib.designs ?? []
const palettes = lib.palettes ?? {}

if (has('list')) {
  console.log('id'.padEnd(10), 'name'.padEnd(14), 'family'.padEnd(12), 'status'.padEnd(8), 'palette')
  for (const d of designs) {
    console.log(
      d.id.padEnd(10),
      (d.name ?? '').padEnd(12),
      (d.family ?? '').padEnd(12),
      (d.status ?? '').padEnd(8),
      d.defaultPalette ?? '-'
    )
  }
  console.log(`\n${designs.length} 个机设 × ${Object.keys(palettes).length} 个配色 = ${designs.length * Object.keys(palettes).length} 种组合`)
  process.exit(0)
}

const wantAll = has('all')
const ids = wantAll
  ? designs.map((d) => d.id)
  : [String(arg('design') ?? '')].filter(Boolean)
if (!ids.length) {
  console.error('需要 --design <id> 或 --all。先 --list 看有哪些。')
  process.exit(1)
}

const seeds = String(arg('seeds', '7601')).split(',').map((s) => s.trim()).filter(Boolean)
const run = String(arg('run', `MECHDESIGN-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`))
const useHires = has('hires')
const paletteOverride = arg('palette', null)
const pose = arg('pose', null)
const depth = arg('depth', null)
const depthStrength = String(arg('depth-strength', lib.defaults.depthStrength))
const steps = String(arg('steps', lib.defaults.steps))
const cfg = String(arg('cfg', lib.defaults.cfg))
const width = String(arg('width', lib.defaults.width))
const height = String(arg('height', lib.defaults.height))
const hiresScale = String(arg('hires-scale', lib.defaults.hires?.scale ?? 1.5))
const hiresDenoise = String(arg('hires-denoise', lib.defaults.hires?.denoise ?? 0.45))
// openpose 骨架只认识人形。多腿 / 半人马 / 蛇身这类机设必须把骨架关掉或压到 0.5 以下，
// 否则模型会照着两条腿的骨架把人形轮廓画回去（实测：骨架 1.0 + depth 0.7 出两条人腿，
// 全关之后四条机械腿直接长出来）。
const noCn = has('no-cn')
const poseStrength = noCn ? '0' : String(arg('pose-strength', lib.defaults.poseStrength ?? 1.0))
const depthStrengthFinal = noCn ? '0' : depthStrength

mkdirSync(join(ROOT, 'experiments/runs', run, 'out'), { recursive: true })

function buildPositive(d, paletteKey) {
  const parts = [lib.style, d.armor]
  const key = paletteKey ?? d.defaultPalette
  const pal = key ? palettes[key] ?? String(key) : null
  if (pal) parts.push(pal)
  return parts.filter(Boolean).join(', ')
}

function runOne(d, paletteKey) {
  const tag = paletteKey && paletteKey !== d.defaultPalette ? `${d.id}-${paletteKey}` : d.id
  const positive = buildPositive(d, paletteKey)
  const script = useHires ? 'scripts_and_tools/hires_face_probe.mjs' : 'scripts_and_tools/cn_gloss_probe.mjs'
  const args = [
    script,
    '--run', run,
    '--tag', tag,
    '--positive', positive,
    '--negative', lib.negative,
    '--seeds', seeds.join(','),
    '--steps', steps,
    '--cfg', cfg,
    '--size', `${width}x${height}`,
    '--depth-strength', depthStrengthFinal,
    '--pose-strength', poseStrength,
    '--force',
  ]
  for (const l of lib.defaults.lora ?? []) args.push('--lora', `${l.name}@${l.strength}`)
  const p = pose ?? lib.defaults.pose
  const dp = depth ?? lib.defaults.depth
  if (p) args.push('--pose', p)
  if (dp) args.push('--depth', dp)
  if (useHires) args.push('--hires', hiresScale, '--hires-denoise', hiresDenoise)
  args.push('--seeds', seeds.join(','))

  console.log(`\n[${tag}] ${d.name ?? d.id}`)
  console.log(`  ${positive}`)
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
    child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${tag} exit ${code}`))))
  })
}

const jobs = []
for (const id of ids) {
  const d = designs.find((x) => x.id === id)
  if (!d) {
    console.error(`未知机设 ${id}。用 --list 看可用列表。`)
    process.exit(1)
  }
  if (paletteOverride && paletteOverride !== true) jobs.push([d, String(paletteOverride)])
  else if (wantAll && Object.keys(palettes).length) {
    // --all 默认只用每个机设自己的配色，避免一次刷出上百张
    jobs.push([d, d.defaultPalette])
  } else jobs.push([d, d.defaultPalette])
}

console.log(`run=${run}  ${jobs.length} 个任务  hires=${useHires ? `${hiresScale}x d${hiresDenoise}` : 'off'}  pose=${poseStrength} depth=${depthStrengthFinal}  seeds=${seeds.join(',')}`)

for (const [d, p] of jobs) {
  await runOne(d, p)
}
console.log(`\n完成 -> experiments/runs/${run}/out/`)
