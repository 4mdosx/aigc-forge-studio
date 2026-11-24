#!/usr/bin/env node
// 机娘直出探针：animagine-xl-4.0-zero + 可选 LoRA + 双 ControlNet（openpose + depth），denoise 1.0。
//
// 和 distill_img2img.mjs 的分工：那个是 img2img 重绘（有源图、看位移），这个是纯生成
// （构图由骨架和深度锁住），用来测「质感有没有进生成阶段」。
//
//   node scripts_and_tools/cn_gloss_probe.mjs --run CN-GLOSS-20261124 \
//     --pose data/pose/standing/1794656866157/bone.png \
//     --depth data/pose/standing/1794656866157/depth.png \
//     --lora gloss_train-gloss-gloss-az-261123-163.safetensors --lora-strength 0.9 \
//     --seeds 7301,7302,7303
//
// 不给 --lora 就是对照组。产物落 experiments/runs/<RUN>/out/。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { basename, extname, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(scriptDir, '..')
const COMFY = process.env.COMFY_BASE || 'http://192.168.8.136:8188'
const CKPT = process.env.CKPT || 'animagine-xl-4.0-zero.safetensors'
const CN_POSE = 'openposeSDXL_v10.safetensors'
const CN_DEPTH = 'xinsircontrolnet-depth-sdxl.safetensors'

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return def
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : def
}
const flag = (name) => process.argv.includes(`--${name}`)

const RUN = arg('run')
if (!RUN) {
  console.error('缺 --run。示例：--run CN-GLOSS-20261124')
  process.exit(1)
}
const POSE = arg('pose')
const DEPTH = arg('depth')
if (!POSE || !DEPTH) {
  console.error('缺 --pose / --depth（骨架图与深度图各一张）')
  process.exit(1)
}

const LORA = arg('lora')
const LORA_S = Number(arg('lora-strength', '0.9'))
const SEEDS = arg('seeds', '7301').split(',').map((s) => Number(s.trim()))
const [W, H] = arg('size', '832x1216').split('x').map(Number)
const STEPS = Number(arg('steps', '30'))
const CFG = Number(arg('cfg', '5'))
const SAMPLER = arg('sampler', 'euler_ancestral')
const CN_POSE_S = Number(arg('pose-strength', '1.0'))
const CN_DEPTH_S = Number(arg('depth-strength', '0.5'))
const TAG = arg('tag', LORA ? `lora${LORA_S}` : 'base')

const POSITIVE =
  arg('positive-file')
    ? readFileSync(resolve(arg('positive-file')), 'utf8').trim()
    : arg('positive') ||
      'masterpiece, best quality, very aesthetic, absurdres, mecha musume, 1girl, solo, ' +
        'standing, full body, looking at viewer, pure white seamless background, ' +
        'white lacquered armor plates, black glossy bodysuit, gold mechanical joints, ' +
        'mechanical limbs, glowing cyan accents, polished armor, clean panel lines'

const NEGATIVE =
  arg('negative-file')
    ? readFileSync(resolve(arg('negative-file')), 'utf8').trim()
    : arg('negative') ||
      'lineart, cel shading, flat colors, hard black outline, sketch, monochrome, watercolor, ' +
        'rust, weathering, matte, segmented armor, muddy, lowres, worst quality, low quality, ' +
        'jpeg artifacts, bad anatomy, bad hands, extra fingers, missing fingers, extra limbs, ' +
        'fused legs, mutated hands, deformed, cropped, feet out of frame, text, signature, ' +
        'watermark, logo, busy background, scenery, colored background, multiple girls, nude, nsfw, chibi'

const RUN_DIR = join(REPO, 'experiments', 'runs', RUN)
mkdirSync(join(RUN_DIR, 'out'), { recursive: true })

async function uploadImage(p) {
  const abs = resolve(p)
  const buf = readFileSync(abs)
  const ext = extname(abs).toLowerCase() || '.png'
  const form = new FormData()
  form.append('image', new Blob([buf], { type: ext === '.png' ? 'image/png' : 'image/jpeg' }), `cnprobe_${basename(dirname(abs))}_${basename(abs)}`)
  form.append('overwrite', 'true')
  form.append('type', 'input')
  const res = await fetch(`${COMFY}/upload/image`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`上传失败 ${p}: ${res.status}`)
  const j = await res.json()
  const ref = j.subfolder ? `${j.subfolder}/${j.name}` : j.name
  console.log(`  上传 input/${ref}`)
  return ref
}

function build(poseRef, depthRef, seed) {
  const wf = {}
  wf['1'] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } }
  const modelSrc = LORA ? ['2', 0] : ['1', 0]
  const clipSrc = LORA ? ['2', 1] : ['1', 1]
  if (LORA) {
    wf['2'] = {
      class_type: 'LoraLoader',
      inputs: { lora_name: LORA, strength_model: LORA_S, strength_clip: LORA_S, model: ['1', 0], clip: ['1', 1] },
    }
  }
  wf['6'] = { class_type: 'CLIPTextEncode', inputs: { text: POSITIVE, clip: clipSrc } }
  wf['7'] = { class_type: 'CLIPTextEncode', inputs: { text: NEGATIVE, clip: clipSrc } }
  wf['11'] = { class_type: 'LoadImage', inputs: { image: poseRef } }
  wf['25'] = { class_type: 'LoadImage', inputs: { image: depthRef } }
  wf['16'] = { class_type: 'ControlNetLoader', inputs: { control_net_name: CN_POSE } }
  wf['22'] = { class_type: 'ControlNetLoader', inputs: { control_net_name: CN_DEPTH } }
  wf['17'] = {
    class_type: 'ControlNetApplyAdvanced',
    inputs: { positive: ['6', 0], negative: ['7', 0], control_net: ['16', 0], image: ['11', 0], strength: CN_POSE_S, start_percent: 0, end_percent: 1 },
  }
  wf['23'] = {
    class_type: 'ControlNetApplyAdvanced',
    inputs: { positive: ['17', 0], negative: ['17', 1], control_net: ['22', 0], image: ['25', 0], strength: CN_DEPTH_S, start_percent: 0, end_percent: 1 },
  }
  wf['50'] = { class_type: 'EmptyLatentImage', inputs: { width: W, height: H, batch_size: 1 } }
  wf['4'] = {
    class_type: 'KSampler',
    inputs: {
      model: modelSrc,
      seed,
      steps: STEPS,
      cfg: CFG,
      sampler_name: SAMPLER,
      scheduler: 'normal',
      positive: ['23', 0],
      negative: ['23', 1],
      latent_image: ['50', 0],
      denoise: 1,
    },
  }
  wf['5'] = { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['1', 2] } }
  wf['8'] = { class_type: 'SaveImage', inputs: { images: ['5', 0], filename_prefix: `cnprobe/${RUN}_${TAG}` } }
  return wf
}

async function main() {
  console.log(`run=${RUN} tag=${TAG} lora=${LORA || '(无)'}@${LORA_S} ${W}x${H} steps=${STEPS} cfg=${CFG}`)
  const poseRef = await uploadImage(POSE)
  const depthRef = await uploadImage(DEPTH)

  const manifest = { run: RUN, tag: TAG, lora: LORA || null, loraStrength: LORA ? LORA_S : 0, size: [W, H], steps: STEPS, cfg: CFG, sampler: SAMPLER, pose: POSE, depth: DEPTH, cn: { pose: CN_POSE_S, depth: CN_DEPTH_S }, positive: POSITIVE, negative: NEGATIVE, results: [] }
  const mfPath = join(RUN_DIR, `manifest-${TAG}.json`)
  if (existsSync(mfPath)) {
    const old = JSON.parse(readFileSync(mfPath, 'utf8'))
    manifest.results = old.results || []
  }

  for (const seed of SEEDS) {
    const tag = `${TAG}-s${seed}`
    if (!flag('force') && manifest.results.some((r) => r.tag === tag && r.file)) {
      console.log(`  skip ${tag}（已存在）`)
      continue
    }
    const wf = build(poseRef, depthRef, seed)
    const res = await fetch(`${COMFY}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: wf, client_id: `cnprobe-${RUN}` }),
    })
    if (!res.ok) throw new Error(`提交失败 ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const { prompt_id: pid } = await res.json()
    console.log(`  ${tag} 已排队 ${pid}`)

    let out = null
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      const h = await fetch(`${COMFY}/history/${pid}`).then((r) => r.json())
      const entry = h[pid]
      if (!entry) continue
      if (entry.status?.status_str === 'error') throw new Error(`${tag} ComfyUI 报错`)
      const imgs = Object.values(entry.outputs || {}).flatMap((o) => o.images || [])
      if (imgs.length) {
        out = imgs[0]
        break
      }
    }
    if (!out) throw new Error(`${tag} 超时没出图`)

    const q = new URLSearchParams({ filename: out.filename, subfolder: out.subfolder || '', type: out.type || 'output' })
    const buf = Buffer.from(await (await fetch(`${COMFY}/view?${q}`)).arrayBuffer())
    const file = `${tag}.png`
    writeFileSync(join(RUN_DIR, 'out', file), buf)
    manifest.results = manifest.results.filter((r) => r.tag !== tag)
    manifest.results.push({ tag, seed, file, comfy: out.filename })
    writeFileSync(mfPath, JSON.stringify(manifest, null, 1))
    console.log(`    -> out/${file}  ${(buf.length / 1024).toFixed(0)} KB`)
  }
  console.log(`\n产物 ${RUN_DIR}/out/  清单 ${mfPath}`)
}

main().catch((e) => {
  console.error(e.message || e)
  process.exit(1)
})
