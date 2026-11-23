#!/usr/bin/env node
// verify_mecha_clone.mjs — 机娘克隆验证矩阵（2026-11-22）
//
// 替代已失效的 verify_ax4z_lora.mjs：POST /tasks 已删，改为只读 SQLite 取
// workflow api_json，直打 ComfyUI /prompt，轮询 /history 取图。
//
// 用法：
//   node scripts_and_tools/verify_mecha_clone.mjs \
//     --run MECHA-CLONE-MATRIX-20261123 \
//     --lora mecha-clone-az-261123-001.safetensors \
//     --strengths 1.0,0.7,0.0 \
//     --seeds 1001 \
//     [--prompts prompts/mecha_clone_matrix.json] [--size 832x1216]
//
// prompts JSON 格式：
//   [{ "id": "native", "pos": "...", "neg": "..." }, ...]
//
// 产物：experiments/runs/<run>/t2i/<promptId>-s<seed>-w<strength>.png
//       以及同目录 manifest.json（记录参数，便于复现）

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const COMFY = process.env.COMFY_URL || 'http://192.168.8.136:8188'
const DB = join(REPO, 'data', 'runner.sqlite')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} 缺值`)
  return v
}

const RUN = arg('run')
if (!RUN) {
  console.error('缺 --run。示例：--run MECHA-CLONE-MATRIX-20261123')
  process.exit(1)
}
const LORA = arg('lora', '')
const STRENGTHS = arg('strengths', '1.0,0.7,0.0').split(',').map(Number)
const SEEDS = arg('seeds', '1001').split(',').map(Number)
const PROMPTS_FILE = resolve(REPO, arg('prompts', 'scripts_and_tools/prompts/mecha_clone_matrix.json'))
const [W, H] = arg('size', '832x1216').split('x').map(Number)

// 只读取当前 head 的 baseline_ax4z workflow
const db = new DatabaseSync(DB, { readOnly: true })
const row = db.prepare(`
  SELECT r.version, r.api_json
  FROM workflows w
  JOIN workflow_branches b ON b.workflow_id = w.id
  JOIN workflow_revisions r ON r.id = b.head_revision_id
  WHERE w.name LIKE 'baseline_ax4z%'
  LIMIT 1
`).get()
if (!row) throw new Error('找不到 baseline_ax4z workflow')
const BASE_WF = JSON.parse(row.api_json)
const WF_VERSION = row.version

const prompts = JSON.parse(readFileSync(PROMPTS_FILE, 'utf8'))
if (!Array.isArray(prompts) || !prompts.length) throw new Error(`${PROMPTS_FILE} 不是非空数组`)

const OUT = join(REPO, 'experiments', 'runs', RUN, 't2i')
mkdirSync(OUT, { recursive: true })

function buildWorkflow(p, seed, strength) {
  const wf = structuredClone(BASE_WF)
  wf['10'].inputs.text = p.pos
  wf['11'].inputs.text = p.neg || ''
  wf['12'].inputs.seed = seed
  wf['13'].inputs.width = W
  wf['13'].inputs.height = H
  if (LORA) {
    wf['17'].inputs.lora_name = LORA
    wf['17'].inputs.strength_model = strength
    wf['17'].inputs.strength_clip = strength
  } else {
    wf['17'].inputs.strength_model = 0
    wf['17'].inputs.strength_clip = 0
  }
  wf['7'].inputs.filename_prefix = `verify/${RUN}/${p.id}-s${seed}-w${strength}`
  return wf
}

async function runOne(p, seed, strength) {
  const tag = `${p.id}-s${seed}-w${strength}`
  const wf = buildWorkflow(p, seed, strength)
  const post = await fetch(`${COMFY}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: wf, client_id: 'lain-verify-mecha' }),
  })
  const res = await post.json()
  if (!post.ok) throw new Error(`${tag} 提交失败: ${JSON.stringify(res).slice(0, 300)}`)
  const id = res.prompt_id
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const h = await (await fetch(`${COMFY}/history/${id}`)).json()
    const entry = h[id]
    if (!entry) continue
    if (entry.status?.status_str === 'error') {
      throw new Error(`${tag} 执行错误: ${JSON.stringify(entry.status).slice(0, 300)}`)
    }
    const imgs = Object.values(entry.outputs || {}).flatMap((o) => o.images || [])
    if (!imgs.length) continue
    const saved = []
    for (const im of imgs) {
      const url = `${COMFY}/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || '')}&type=${im.type || 'output'}`
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
      const path = join(OUT, `${tag}.png`)
      writeFileSync(path, buf)
      saved.push(path)
    }
    return saved
  }
  throw new Error(`${tag} 超时（300s）。ComfyUI 队列可能僵死，检查 GET /queue 的 queue_running`)
}

const manifest = {
  run: RUN, lora: LORA, workflowVersion: WF_VERSION,
  strengths: STRENGTHS, seeds: SEEDS, size: [W, H],
  prompts: prompts.map((p) => p.id),
  startedAt: new Date().toISOString(), results: [],
}
let ok = 0, fail = 0
for (const p of prompts) {
  for (const seed of SEEDS) {
    for (const s of STRENGTHS) {
      try {
        const files = await runOne(p, seed, s)
        console.log(`ok   ${p.id} seed=${seed} w=${s} -> ${files.map((f) => f.split('/').pop()).join(', ')}`)
        manifest.results.push({ prompt: p.id, seed, strength: s, files })
        ok++
      } catch (e) {
        console.error(`FAIL ${p.id} seed=${seed} w=${s}: ${e.message}`)
        manifest.results.push({ prompt: p.id, seed, strength: s, error: e.message })
        fail++
      }
    }
  }
}
manifest.finishedAt = new Date().toISOString()
manifest.ok = ok
manifest.fail = fail
writeFileSync(join(OUT, '..', 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`\n完成 ${ok} 成功 / ${fail} 失败。产物 ${OUT}`)
if (fail) process.exit(1)
