#!/usr/bin/env node
// distill_img2img.mjs — img2img 自举蒸馏（2026-11-22）
//
// 目的：图库里凑不出一组「同画风」样本时，用参考图本身当底图，img2img 生成
// 同材质同设计、但构图/姿态/视角不同的变体，人工筛掉走形的再拿去训 LoRA。
// 这样风格锚始终在源图上，不引入第二个画师的先验。
//
// 与 verify_mecha_clone.mjs 的关系：那个是训完之后的验证矩阵，这个是训之前的
// 扩样本。两者都直打 ComfyUI，不走 runner（POST /tasks 已删）。
//
// 用法：
//   # 先看组合，不上传不提交
//   node scripts_and_tools/distill_img2img.mjs --run DISTILL-SCOUT --dry
//
//   # 探针：只跑 2 个变体 × 3 档 denoise × 1 seed，判断哪档保材质
//   node scripts_and_tools/distill_img2img.mjs --run DISTILL-SCOUT-20261123 \
//     --variants a1-front,b3-kneeling --denoise 0.45,0.55,0.65 --seeds 2001
//
//   # 正式收割：全部 12 变体 × 2 seed，denoise 用 prompt 文件里的推荐值
//   node scripts_and_tools/distill_img2img.mjs --run DISTILL-BOOT-20261123 \
//     --seeds 2001,2002
//
// 产物：experiments/runs/<run>/distill/*.png
//       experiments/runs/<run>/manifest.json   参数与结果索引
//       experiments/runs/<run>/report.json     色调统计与偏差判定
//       experiments/runs/<run>/review.md       人审清单（含每张的指标）
//       experiments/runs/<run>/contactsheet.png 审阅网格
//
// 人审通过后的入库路径（设计上不做自动入库，避免脏图混进数据集）：
//   把选中的 png 拷进 data/capture/distill_<date>/ 后触发 /capture 扫描 → 打标 → 加数据集

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const WORKSPACE = resolve(REPO, '..')
const COMFY = process.env.COMFY_URL || 'http://192.168.8.136:8188'
const DB = join(REPO, 'data', 'runner.sqlite')
const TONE_TOOL_DIR = join(WORKSPACE, 'tools')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} 缺值`)
  return v
}
const flag = (name) => process.argv.includes(`--${name}`)

const RUN = arg('run')
if (!RUN) {
  console.error('缺 --run。示例：--run DISTILL-BOOT-20261123')
  process.exit(1)
}
const DRY = flag('dry')
const FORCE = flag('force')
const PROMPTS_FILE = resolve(REPO, arg('prompts', 'scripts_and_tools/prompts/mecha_distill.json'))
const LORA = arg('lora', '')
const LORA_S = Number(arg('lora-strength', '0.8'))
const STEPS = Number(arg('steps', '30'))
const CFG = Number(arg('cfg', '6'))
const SAMPLER = arg('sampler', 'dpmpp_2m')
const SCHEDULER = arg('scheduler', 'karras')
const SEEDS = arg('seeds', '2001,2002').split(',').map((s) => Number(s.trim())).filter(Boolean)
const DENOISE_ARG = arg('denoise', 'auto')
// auto = 用 prompt 文件里每变体的推荐值；显式给值时支持多档扫描 0.45,0.55,0.65
const DENOISE_LIST =
  DENOISE_ARG === 'auto'
    ? null
    : DENOISE_ARG.split(',')
        .map((x) => Number(x.trim()))
        .filter((x) => Number.isFinite(x) && x > 0 && x < 1)
if (DENOISE_ARG !== 'auto' && (!DENOISE_LIST || !DENOISE_LIST.length)) {
  throw new Error(`--denoise 无法解析：${DENOISE_ARG}（应为 auto 或 0.42,0.55 这类 0~1 之间的小数）`)
}
const ONLY_VARIANTS = arg('variants', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const LIMIT = Number(arg('limit', '0'))
const SIZE = arg('size', 'auto') // auto | WxH

// ── 源图 ──────────────────────────────────────────────────────────────────
// 默认取参考图的 originals 版（1080x1920）。库里 736x1308 的压缩版不要用来当
// img2img 底图，放大糊了之后高频细节就没了，训出来的材质会偏软。
const HOME = process.env.HOME || '/Users/token'
const DEFAULT_SRC = join(HOME, 'WorkBuddy', 'AIGC', 'output', 'porcelain-style-lora', 'originals', '20261120-155720-5807.jpg')

function resolveSources() {
  const raw = arg('source', '')
  if (raw) {
    return raw.split(',').map((p) => resolve(p.trim())).filter(Boolean)
  }
  // 没有显式指定时：先找 originals，再退回 DB 里的 processed
  const cands = [
    DEFAULT_SRC,
    join(REPO, 'data', 'capture', 'assets', '7fbfe119c7789c8347703dd03da6f0283950b591fcae3ad0b407c12169ddafba', 'processed.png'),
  ]
  const hit = cands.find((p) => existsSync(p))
  if (hit) return [hit]
  const db = new DatabaseSync(DB, { readOnly: true })
  const r = db.prepare("SELECT processed_path FROM image_assets WHERE id = '20261120-155720-5807'").get()
  if (r?.processed_path) return [join(REPO, 'data', r.processed_path)]
  throw new Error('找不到源图，用 --source 指定')
}

// ── 尺寸 ──────────────────────────────────────────────────────────────────
// auto：按源图比例算，目标面积 ≈ 1024²，对齐 64。SDXL 在 3080 10GB 上
// 832x1472 也能跑，但 768x1344 更稳，先按面积 1.05M 走。
const TARGET_AREA = 1024 * 1024

function autoSize(srcPath) {
  const r = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', srcPath], { encoding: 'utf8' })
  const wm = (r.stdout || '').match(/pixelWidth:\s*(\d+)/)
  const hm = (r.stdout || '').match(/pixelHeight:\s*(\d+)/)
  if (!wm || !hm) return [768, 1344]
  const sw = Number(wm[1])
  const sh = Number(hm[1])
  const ratio = sw / sh
  let h = Math.sqrt(TARGET_AREA / ratio)
  let w = h * ratio
  const snap = (x) => Math.min(1536, Math.max(512, Math.round(x / 64) * 64))
  return [snap(w), snap(h)]
}

// ── prompt 矩阵 ───────────────────────────────────────────────────────────
const spec = JSON.parse(readFileSync(PROMPTS_FILE, 'utf8'))
if (!spec.material || !Array.isArray(spec.variants) || !spec.variants.length) {
  throw new Error(`${PROMPTS_FILE} 缺 material 或 variants`)
}
let variants = spec.variants
if (ONLY_VARIANTS.length) {
  variants = variants.filter((v) => ONLY_VARIANTS.includes(v.id))
  if (!variants.length) throw new Error(`--variants 没匹配到任何变体：${ONLY_VARIANTS.join(',')}`)
}

// material 段前置：前 77 token 内的权重最高，风格因子必须站在这里
const fullPrompt = (v) => `${spec.material}, ${v.pose}`
const denoiseOf = (v) => Number(v.denoise ?? 0.55)
const denoiseListOf = (v) => DENOISE_LIST ?? [denoiseOf(v)]

const sources = resolveSources()
const [W, H] = SIZE === 'auto' ? autoSize(sources[0]) : SIZE.split('x').map(Number)

// 源图短标签：asset id 取末段（20261120-155720-5807 -> 5807），hash 名取末 6 位
const srcTagOf = (p) => {
  const b = basename(p, extname(p))
  const tail = b.split(/[-_]/).pop() || b
  return tail.slice(-6) || 'src'
}

// ── 组合展开 ──────────────────────────────────────────────────────────────
// 多档 denoise 与多源图都会乘进来，用 --limit 卡住总量。
const jobs = []
for (const src of sources) {
  const srcTag = srcTagOf(src)
  for (const v of variants) {
    for (const dn of denoiseListOf(v)) {
      for (const seed of SEEDS) {
        jobs.push({
          src,
          srcTag,
          variant: v.id,
          group: v.group,
          seed,
          denoise: dn,
          steps: STEPS,
          cfg: CFG,
          size: [W, H],
          pos: fullPrompt(v),
          neg: spec.negative || '',
          tag: `${srcTag}-${v.id}-d${dn}-s${seed}`,
        })
      }
    }
  }
}
const finalJobs = LIMIT > 0 ? jobs.slice(0, LIMIT) : jobs

console.log(`源图 ${sources.length} 张 | 变体 ${variants.length} | seed ${SEEDS.length} | 尺寸 ${W}x${H}`)
console.log(`共 ${finalJobs.length} 个组合${LIMIT ? `（--limit ${LIMIT}）` : ''}`)
if (DRY) {
  for (const j of finalJobs) {
    console.log(`  ${j.tag}  dn=${j.denoise}  ${j.variant}`)
  }
  console.log('\n--dry：不连 ComfyUI，不上传，不生成。')
  process.exit(0)
}

// ── ComfyUI ───────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB, { readOnly: true })
const wfRow = db.prepare(`
  SELECT r.version, r.api_json
  FROM workflows w
  JOIN workflow_branches b ON b.workflow_id = w.id
  JOIN workflow_revisions r ON r.id = b.head_revision_id
  WHERE w.name LIKE 'baseline_ax4z%'
  LIMIT 1
`).get()
if (!wfRow) throw new Error('找不到 baseline_ax4z workflow')
const CKPT = JSON.parse(wfRow.api_json)['15'].inputs.ckpt_name
const WF_VERSION = wfRow.version

async function preflight() {
  try {
    const st = await (await fetch(`${COMFY}/system_stats`)).json()
    const dev = (st.devices || [])[0] || {}
    const q = await (await fetch(`${COMFY}/queue`)).json()
    const running = (q.queue_running || []).length
    const pending = (q.queue_pending || []).length
    console.log(`ComfyUI ${dev.name || '?'}  VRAM free ${(dev.vram_free / 1e9).toFixed(1)}/${(dev.vram_total / 1e9).toFixed(1)}GB  队列 running=${running} pending=${pending}`)
    if (running > 0) {
      console.warn('⚠ 队列有任务在跑：本次提交会排在后面，单张超时可能被误判。若那任务是僵死的，先 POST /interrupt。')
    }
  } catch (e) {
    throw new Error(`ComfyUI 不可达 ${COMFY}: ${e.message}`)
  }
}

async function uploadSource(src) {
  const buf = readFileSync(src)
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 12)
  const ext = extname(src).toLowerCase() || '.png'
  const name = `distill_src_${hash}${ext}`
  const form = new FormData()
  form.append('image', new Blob([buf], { type: ext === '.png' ? 'image/png' : 'image/jpeg' }), name)
  form.append('overwrite', 'true')
  form.append('type', 'input')
  const res = await fetch(`${COMFY}/upload/image`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`上传失败 ${src}: ${res.status} ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  // LoadImage 认 "subfolder/name" 形式；subfolder 为空时只给 name
  const ref = j.subfolder ? `${j.subfolder}/${j.name}` : j.name
  console.log(`  源图已上传 input/${ref}`)
  return ref
}

function buildWorkflow(job, srcRef) {
  const wf = {}
  wf['15'] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } }
  const model = LORA ? ['17', 0] : ['15', 0]
  const clip = LORA ? ['17', 1] : ['15', 1]
  if (LORA) {
    wf['17'] = {
      class_type: 'LoraLoader',
      inputs: { lora_name: LORA, strength_model: LORA_S, strength_clip: LORA_S, model: ['15', 0], clip: ['15', 1] },
    }
  }
  wf['100'] = { class_type: 'LoadImage', inputs: { image: srcRef } }
  // center crop 而不是 stretch：源图 9:16 与 768x1344 只差 0.5%，裁掉的边不影响
  wf['101'] = {
    class_type: 'ImageScale',
    inputs: { image: ['100', 0], upscale_method: 'lanczos', width: W, height: H, crop: 'center' },
  }
  wf['102'] = { class_type: 'VAEEncode', inputs: { pixels: ['101', 0], vae: ['15', 2] } }
  wf['10'] = { class_type: 'CLIPTextEncode', inputs: { text: job.pos, clip } }
  wf['11'] = { class_type: 'CLIPTextEncode', inputs: { text: job.neg, clip } }
  wf['12'] = {
    class_type: 'KSampler',
    inputs: {
      seed: job.seed,
      steps: job.steps,
      cfg: job.cfg,
      sampler_name: SAMPLER,
      scheduler: SCHEDULER,
      denoise: job.denoise,
      model,
      positive: ['10', 0],
      negative: ['11', 0],
      latent_image: ['102', 0],
    },
  }
  wf['14'] = { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['15', 2] } }
  wf['7'] = { class_type: 'SaveImage', inputs: { images: ['14', 0], filename_prefix: `distill/${RUN}/${job.tag}` } }
  return wf
}

const OUT = join(REPO, 'experiments', 'runs', RUN, 'distill')
mkdirSync(OUT, { recursive: true })

async function runOne(job, srcRef) {
  const dest = join(OUT, `${job.tag}.png`)
  if (existsSync(dest) && !FORCE) {
    console.log(`skip ${job.tag}（已存在，--force 覆盖）`)
    return { ...job, file: dest, skipped: true }
  }
  const wf = buildWorkflow(job, srcRef)
  const post = await fetch(`${COMFY}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: wf, client_id: 'lain-distill-mecha' }),
  })
  const res = await post.json()
  if (!post.ok) {
    const msg = res?.error?.message || JSON.stringify(res).slice(0, 300)
    throw new Error(`提交失败: ${msg}`)
  }
  const id = res.prompt_id
  const deadline = Date.now() + 600_000 // img2img 30 步在 3080 上 300s 足够，留一倍余量
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    const h = await (await fetch(`${COMFY}/history/${id}`)).json()
    const entry = h[id]
    if (!entry) continue
    if (entry.status?.status_str === 'error') {
      throw new Error(`执行错误: ${JSON.stringify(entry.status).slice(0, 300)}`)
    }
    const imgs = Object.values(entry.outputs || {}).flatMap((o) => o.images || [])
    if (!imgs.length) continue
    const im = imgs[0]
    const url = `${COMFY}/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || '')}&type=${im.type || 'output'}`
    writeFileSync(dest, Buffer.from(await (await fetch(url)).arrayBuffer()))
    return { ...job, file: dest }
  }
  throw new Error('超时 600s。检查 GET /queue：running 恒为 1 说明 ComfyUI 僵死，需重启')
}

// ── 执行 ──────────────────────────────────────────────────────────────────
await preflight()

const srcRefs = new Map()
for (const src of sources) {
  srcRefs.set(src, await uploadSource(src))
}

const results = []
let ok = 0
let fail = 0
const t0 = Date.now()
for (let i = 0; i < finalJobs.length; i++) {
  const job = finalJobs[i]
  const prefix = `[${i + 1}/${finalJobs.length}]`
  try {
    const r = await runOne(job, srcRefs.get(job.src))
    console.log(`${prefix} ${r.skipped ? 'skip' : 'ok  '} ${job.tag}`)
    results.push({ ...r, src: basename(r.src), file: basename(r.file) })
    if (!r.skipped) ok++
  } catch (e) {
    console.error(`${prefix} FAIL ${job.tag}: ${e.message}`)
    results.push({ ...job, src: basename(job.src), error: e.message })
    fail++
  }
  if (jobs.length > 4 && fail >= 3 && ok === 0) {
    console.error('\n连续失败且零产出，中止。先确认 ComfyUI 是否僵死。')
    break
  }
}

const manifest = {
  run: RUN,
  kind: 'img2img-distill',
  comfy: COMFY,
  checkpoint: CKPT,
  workflowVersion: WF_VERSION,
  lora: LORA || null,
  loraStrength: LORA ? LORA_S : 0,
  size: [W, H],
  steps: STEPS,
  cfg: CFG,
  sampler: SAMPLER,
  scheduler: SCHEDULER,
  sources: sources.map((s) => ({ path: s, input: srcRefs.get(s) })),
  promptSpec: PROMPTS_FILE,
  variants: variants.map((v) => ({ id: v.id, group: v.group, denoise: denoiseOf(v), note: v.note })),
  startedAt: new Date().toISOString(),
  elapsedSec: Math.round((Date.now() - t0) / 1000),
  ok,
  fail,
  results,
}
writeFileSync(join(REPO, 'experiments', 'runs', RUN, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`\n生成 ${ok} 张 / 失败 ${fail}，用时 ${manifest.elapsedSec}s -> ${OUT}`)
if (fail && !ok) process.exit(1)

// ── 色调统计与初筛 ────────────────────────────────────────────────────────
// 只做「能不能进人审队列」的粗筛：亮度过低（暗背景）、饱和过高（跑回动漫平涂）、
// 边缘密度过高（线稿感回来了）的直接标红，省人审的眼力。
const PY = `
import json, sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(TONE_TOOL_DIR)})
from image_tone_stats import stats
d = Path(sys.argv[1])
out = {}
for p in sorted(d.glob('*.png')):
    try:
        out[p.stem] = stats(str(p))
    except Exception as e:
        out[p.stem] = {'error': str(e)}
srcs = json.loads(sys.argv[2])
for k, v in srcs.items():
    out['__src__' + k] = stats(v)
print(json.dumps(out))
`
let tones = {}
let srcTones = {}
try {
  const py = spawnSync('python3', ['-c', PY, OUT, JSON.stringify(Object.fromEntries(sources.map((s) => [srcTagOf(s), s])))], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (py.status === 0) {
    const all = JSON.parse(py.stdout)
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('__src__')) srcTones[k.slice(7)] = v
      else tones[k] = v
    }
  } else {
    console.warn('色调统计失败（跳过初筛）:', (py.stderr || '').slice(0, 300))
  }
} catch (e) {
  console.warn('色调统计失败（跳过初筛）:', e.message)
}

// 阈值：以源图为基准的允许偏移。这是初筛不是终判，放宽一点，只抓明显跑偏的。
const LIMITS = { lum: 18, sat: 10, contrast: 20, edge: 7, hf: 3 }
const baseKey = srcTagOf(sources[0])
const base = srcTones[baseKey] || {}
const review = []
for (const r of results) {
  if (!r.file) continue
  const stem = r.file.replace(/\.png$/, '')
  const t = tones[stem]
  if (!t || t.error) {
    review.push({ ...r, tone: null, flags: ['统计失败'] })
    continue
  }
  const flags = []
  if (base.lum) {
    for (const k of Object.keys(LIMITS)) {
      if (t[k] === undefined || base[k] === undefined) continue
      const d = t[k] - base[k]
      if (Math.abs(d) > LIMITS[k]) flags.push(`${k}${d > 0 ? '+' : ''}${d.toFixed(1)}`)
    }
  }
  review.push({ ...r, tone: t, delta: base.lum ? Object.fromEntries(Object.keys(LIMITS).map((k) => [k, +(t[k] - base[k]).toFixed(1)])) : null, flags })
}

writeFileSync(
  join(REPO, 'experiments', 'runs', RUN, 'report.json'),
  JSON.stringify({ run: RUN, sourceTone: base, limits: LIMITS, items: review }, null, 2),
)

// ── 人审清单 ──────────────────────────────────────────────────────────────
const md = []
md.push(`# ${RUN} — img2img 自举蒸馏\n`)
md.push(`底模 \`${CKPT}\`${LORA ? ` + LoRA \`${LORA}\` @${LORA_S}` : '（无 LoRA）'} ｜ ${W}×${H} ｜ ${STEPS} 步 ｜ cfg ${CFG} ｜ denoise 见每行\n`)
md.push(`源图：${sources.map((s) => `\`${basename(s)}\``).join('、')}\n`)
if (base.lum) {
  md.push(`源图基准：lum ${base.lum} / contrast ${base.contrast} / sat ${base.sat} / edge ${base.edge} / hf ${base.hf}\n`)
  md.push(`初筛容差：${Object.entries(LIMITS).map(([k, v]) => `${k}±${v}`).join(' / ')}（超出即标 ⚠，仍需人眼复核）\n`)
}
md.push('\n| 变体 | seed | denoise | lum | sat | edge | hf | 偏差 | 判定 |')
md.push('|---|---|---|---|---|---|---|---|---|')
for (const r of review) {
  const t = r.tone || {}
  const d = r.delta ? `Δlum ${r.delta.lum} / Δsat ${r.delta.sat} / Δedge ${r.delta.edge}` : '—'
  const verdict = r.flags?.length ? `⚠ ${r.flags.join(' ')}` : '✓ 待看'
  md.push(`| ${r.variant} | ${r.seed} | ${r.denoise} | ${t.lum ?? '—'} | ${t.sat ?? '—'} | ${t.edge ?? '—'} | ${t.hf ?? '—'} | ${d} | ${verdict} |`)
}
md.push('\n## 人审要看的三件事\n')
md.push('1. **材质是否还在**：白瓷的倒角高光、黑漆皮的反射、黄铜关节的粗糙度。这是唯一不可妥协的项，丢了这张就不能进训练集。')
md.push('2. **结构是否合理**：装甲板缝闭合、关节有机械逻辑、手指和腿没有融在一起。img2img 高 denoise 下最容易崩这里。')
md.push('3. **是否真的换了构图**：如果 B 组（denoise 0.6+）出来的还是原图站位，说明单靠 denoise 换不动姿态，需要上 ControlNet 或换策略——这个结论本身也是实验产出。\n')
md.push('## 入库路径\n')
md.push('选中后把 png 拷进 `data/capture/distill_<date>/`，跑 `/capture` 扫描 → WD14 打标 → 加进 `mecha_clone_train`。三件事必须做：')
md.push('- 打标后手工补一条风格 tag（如 `porcelain_mecha_style`），训练时作为触发词；')
md.push('- 蒸馏图与真图的比例不要超过 1:1，否则训出来的是 img2img 的平滑平均，反而更远离参考图；')
md.push('- 每批蒸馏图都要留 2 张不进训练，用于事后判断这轮自举有没有引入系统性偏差（比如所有图都变柔）。')
writeFileSync(join(REPO, 'experiments', 'runs', RUN, 'review.md'), md.join('\n'))

// ── 审阅网格 ──────────────────────────────────────────────────────────────
// 行 = 变体，列 = 源图 + 各 seed。用统一工具拼，别自己另写一套。
const gridRows = []
const seedsPresent = [...new Set(results.filter((r) => r.file).map((r) => r.seed))]
for (const v of variants) {
  for (const dn of denoiseListOf(v)) {
    const cells = seedsPresent.map((seed) => {
      const hit = results.find((r) => r.variant === v.id && r.seed === seed && r.denoise === dn && r.file)
      return hit ? join(OUT, hit.file) : ''
    })
    if (cells.every((c) => !c)) continue
    gridRows.push([v.id, `dn ${dn}`, ...cells].join('|'))
  }
}
if (gridRows.length) {
  const grid = join(REPO, 'experiments', 'runs', RUN, 'contactsheet.png')
  const cols = ['源图', ...seedsPresent.map((s) => `seed ${s}`)].join(',')
  const srcRow = sources.map((s) => `源图 ${srcTagOf(s)}|dn -|${s}`).join(';')
  const args = [
    'tools/compare_grid.py',
    '--out', grid,
    '--title', `${RUN}  img2img 蒸馏 · ${W}x${H} · ${LORA ? 'LoRA ' + LORA : '无 LoRA'}`,
    '--cols', cols,
    '--rows', `${srcRow};${gridRows.join(';')}`,
    '--cell', '300',
  ]
  const r = spawnSync('python3', args, { cwd: WORKSPACE, encoding: 'utf8' })
  if (r.status === 0) console.log(`\n网格 -> ${grid}\n${r.stdout.trim()}`)
  else console.warn('网格生成失败（不影响产物）:', (r.stderr || '').slice(0, 300))
}

console.log(`\n清单 -> ${join(REPO, 'experiments', 'runs', RUN, 'review.md')}`)
console.log('下一步：看网格 → 在 review.md 里圈掉不能用的 → 剩下的走 data/capture 入库')
