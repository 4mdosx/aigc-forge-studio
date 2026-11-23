#!/usr/bin/env node
// augment_captions.mjs — 给导出好的 caption 前置风格段（2026-11-22）
//
// 背景：export_dataset.mjs 只会输出 WD14 tags。上一轮 hemi_real 的教训是——
// caption 里没有风格因子的文字载体时，LoRA 只能学整体色调偏移（实测就是去饱和 +
// 压细节 + 降对比），触发词失效。所以风格段必须写进 caption 并且站在最前面，
// 让它在 CLIP 的位置编码里拿到最高权重。
//
// 用法：
//   node scripts_and_tools/augment_captions.mjs \
//     --dir data/training-export/mecha_clone_train/img \
//     --trigger pmkstyle --dry-run
//
//   node scripts_and_tools/augment_captions.mjs --dir ... --trigger pmkstyle
//
// 幂等：文件里已含 --marker（默认 @style-v1）时跳过，可反复跑。
// 只在触发词后面插入风格段，原有 tags 顺序不动。

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    trigger: { type: 'string', default: '' },
    style: { type: 'string', default: '' },
    marker: { type: 'string', default: '@style-v1' },
    'dry-run': { type: 'boolean', default: false },
  },
})
if (!values.dir) {
  console.error('需要 --dir <caption 目录>')
  process.exit(1)
}

// 风格段必须描述训练集**实际的样子**，不能描述**想要的样子**。
// 第一版写了 3d render / glossy white ceramic，而 24 张里只有 3 张真有瓷面高光，
// 其余是 2D 厚涂——那是 label noise，会把「3d render」这些词错误地和厚涂绑定，
// 以后 prompt 写这些话反而触发 2D。改成实际共性：白底、覆面、复杂机械、硬表面。
// 3D 瓷面要靠蒸馏图（denoise 0.72–0.78 那批）在第二轮承担，那批的 caption 另写。
const DEFAULT_STYLE = [
  'mecha musume',
  'full body',
  'white background',
  'faceless helmet',
  'complex mechanical design',
  'hard surface armor',
  'sharp panel lines',
]

const style = (values.style ? values.style.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_STYLE).join(', ')
const dir = resolve(values.dir)
const files = readdirSync(dir).filter((f) => f.endsWith('.txt'))
if (!files.length) throw new Error(`${dir} 里没有 .txt`)

let changed = 0
let skipped = 0
let maxTokens = 0
let maxFile = ''
for (const f of files) {
  const p = join(dir, f)
  const raw = readFileSync(p, 'utf8').trim()
  if (raw.includes(values.marker)) {
    skipped++
    continue
  }
  const parts = raw
    .replace(/,\s*$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  let out
  if (values.trigger && parts[0] === values.trigger) {
    out = [parts[0], style, ...parts.slice(1)].join(', ')
  } else if (values.trigger) {
    // 触发词不在首位（或没有），直接前置
    out = [values.trigger, style, ...parts].join(', ')
  } else {
    out = [style, ...parts].join(', ')
  }
  out = `${out}, ${values.marker},`
  // 粗估 token：每个 tag 平均 1.3 token
  const est = Math.round(out.split(',').filter((s) => s.trim()).length * 1.3)
  if (est > maxTokens) {
    maxTokens = est
    maxFile = f
  }
  if (!values['dry-run']) writeFileSync(p, out)
  changed++
}

console.log(`${values['dry-run'] ? '[dry] ' : ''}处理 ${files.length} 个 caption：改写 ${changed}、跳过 ${skipped}`)
console.log(`风格段：${style}`)
console.log(`最长 caption 约 ${maxTokens} token（${maxFile}）${maxTokens > 75 ? '  ⚠ 超过 75，尾部 tags 会被截断' : ''}`)
if (changed && values['dry-run']) {
  console.log('\n样例：')
  console.log(readFileSync(join(dir, files[0]), 'utf8').trim().slice(0, 200))
  const parts = readFileSync(join(dir, files[0]), 'utf8').trim().replace(/,\s*$/, '').split(',').map((s) => s.trim()).filter(Boolean)
  const preview = [parts[0], style, ...parts.slice(1)].join(', ')
  console.log('->')
  console.log(preview.slice(0, 300))
}
