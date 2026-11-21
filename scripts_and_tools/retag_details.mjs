// 批量重打 WD14：给已有图补 sidecar tagDetails（category + 置信度分数）。
//
// 背景：capture 链路把 tags 直接写进 DB，tagger 那套根 image/<id>.json 在本部署下
// 从没跑过，导致 /tag/item 拿不到带分数的 details，前端分组只能 CSV 查表（score=0）。
//
// 本脚本只补 sidecar meta 的 tagDetails，不改 DB tags（页面显示的真相源）、不写 txt：
//   - GET /tag/item 的 tags 走 DB 回退，details 走 sidecar → 两边一致
//   - 断点续跑：已有 tagDetails 的跳过，--force 才重打
//
// 用法：
//   node scripts_and_tools/retag_details.mjs --limit 5          # 小样本
//   node scripts_and_tools/retag_details.mjs                    # 全量
//   node scripts_and_tools/retag_details.mjs --force            # 连已补过的重打
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = new URL('..', import.meta.url).pathname
const dataDir = join(root, 'data')
const captureDir = join(dataDir, 'capture')
const metaDir = join(captureDir, 'image')

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const has = (name) => args.includes(name)
const limit = Number(arg('--limit', '0'))
const force = has('--force')
const modelId = arg('--model', 'wd-eva02-large-tagger-v3')

const { loadSession, tagFile } = await import('../runner/src/tag/wd14.ts')

const db = new DatabaseSync(join(dataDir, 'runner.sqlite'), { readOnly: true })
const rows = db
  .prepare(
    "SELECT id, processed_path, original_path, tags_json, tags_model_version FROM image_assets WHERE tags_json != '[]' ORDER BY id",
  )
  .all()
const targets = limit > 0 ? rows.slice(0, limit) : rows
console.log(`[retag] total=${rows.length} targets=${targets.length} model=${modelId} force=${force}`)

const ses = await loadSession(join(dataDir, 'models'), modelId, (m) =>
  console.log(`[retag] ${m}`),
)

let done = 0
let skipped = 0
let failed = 0
const t0 = Date.now()

for (const row of targets) {
  const metaFile = join(metaDir, `${row.id}.json`)
  if (!force && existsSync(metaFile)) {
    try {
      const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
      if (Array.isArray(meta.tagDetails) && meta.tagDetails.length > 0) {
        skipped += 1
        continue
      }
    } catch {
      // 损坏的 meta 当没补过，重打
    }
  }

  const rel = row.processed_path || row.original_path
  const file = join(dataDir, rel)
  if (!existsSync(file)) {
    console.warn(`[retag] MISSING ${row.id}: ${file}`)
    failed += 1
    continue
  }

  try {
    const result = await tagFile(file, ses)
    mkdirSync(metaDir, { recursive: true })
    const meta = {
      id: row.id,
      tags: JSON.parse(row.tags_json), // 保留 DB 真相源的 tags，不用推理结果覆盖
      tagDetails: result.details,
      tagRating: result.rating,
      tagger: row.tags_model_version || modelId,
      tagThreshold: 0.35,
      tagCharThreshold: 0.85,
      taggedAt: new Date().toISOString(),
      retagged: true,
    }
    writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8')
    done += 1
    if (done % 50 === 0 || done === targets.length) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0)
      console.log(
        `[retag] ${done}/${targets.length} done, ${skipped} skipped, ${failed} failed, ${elapsed}s elapsed`,
      )
    }
  } catch (err) {
    console.warn(`[retag] FAIL ${row.id}: ${err instanceof Error ? err.message : String(err)}`)
    failed += 1
  }
}

db.close()
console.log(
  `[retag] DONE done=${done} skipped=${skipped} failed=${failed} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`,
)
