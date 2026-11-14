// character_v2 → v3：摘除 lineart 死链（H 组定稿：构图线稿不进节点，depth+skeleton 双锁）
// 1. ui 删节点 40(LoadImage lineart)/51(ImageInvert)/41(Scribble CN loader)/42(Apply Scribble)
//    17(Apply Skeleton) 的 positive/negative 改接 6(Positive)/7(Negative)
// 2. 写回 ComfyUI userdata
// 3. runner commit 建新版本（message 必填）
import { DatabaseSync } from 'node:sqlite'

const DB = '/Users/token/workspace/AIGC/aigc-forge-studio/data/runner.sqlite'
const COMFY = 'http://192.168.8.136:8188'
const RUNNER = 'http://127.0.0.1:8787'
const WORKFLOW = 'character_v2'
const REMOVE = new Set([40, 41, 42, 51])

const db = new DatabaseSync(DB)
const row = db
  .prepare(
    `SELECT r.ui_json FROM workflow_revisions r
     JOIN workflows w ON w.id = r.workflow_id
     JOIN workflow_branches b ON b.workflow_id = w.id AND b.name = w.current_branch
     WHERE w.name = ? AND r.id = b.head_revision_id`,
  )
  .get(WORKFLOW)
if (!row) throw new Error(`no head revision for ${WORKFLOW}`)
const ui = JSON.parse(row.ui_json)

// ---- 编辑 ----
const byId = new Map(ui.nodes.map((n) => [n.id, n]))
const skeleton = byId.get(17)
const pos = byId.get(6)
const neg = byId.get(7)

// 收集要删的 link id（涉及被删节点 + 42→17 的两条）
const deadLinks = new Set()
for (const l of ui.links) {
  const [, from, , to] = l
  if (REMOVE.has(from) || REMOVE.has(to)) deadLinks.add(l[0])
}
if (!deadLinks.has(16) || !deadLinks.has(17)) {
  throw new Error(`unexpected wiring: links 16/17 not from removed node`)
}

// 新 link：6→17.positive、7→17.negative
const nextLink = ui.last_link_id + 1
const linkPos = [nextLink, pos.id, 0, 17, 0, 'CONDITIONING']
const linkNeg = [nextLink + 1, neg.id, 0, 17, 1, 'CONDITIONING']

skeleton.inputs[0].link = nextLink
skeleton.inputs[1].link = nextLink + 1
pos.outputs[0].links = pos.outputs[0].links.filter((id) => !deadLinks.has(id)).concat([nextLink])
neg.outputs[0].links = neg.outputs[0].links.filter((id) => !deadLinks.has(id)).concat([nextLink + 1])

ui.nodes = ui.nodes.filter((n) => !REMOVE.has(n.id))
ui.links = ui.links
  .filter((l) => !deadLinks.has(l[0]))
  .concat([linkPos, linkNeg])
ui.last_link_id = nextLink + 1

// 校验：无悬空 link 引用
const live = new Set(ui.links.map((l) => l[0]))
for (const n of ui.nodes) {
  for (const input of n.inputs ?? []) {
    if (input.link !== null && !live.has(input.link)) {
      throw new Error(`dangling input link ${input.link} on node ${n.id}`)
    }
  }
  for (const output of n.outputs ?? []) {
    for (const id of output.links ?? []) {
      if (!live.has(id)) throw new Error(`dangling output link ${id} on node ${n.id}`)
    }
  }
}
for (const [id, from, , to] of ui.links) {
  if (!byId.has(from) || !byId.has(to)) {
    throw new Error(`link ${id} references removed node`)
  }
}

// ---- 写回 ComfyUI ----
const writeRes = await fetch(
  `${COMFY}/userdata/${encodeURIComponent(`workflows/${WORKFLOW}.json`)}?overwrite=true`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ui) },
)
if (!writeRes.ok) {
  throw new Error(`ComfyUI write failed: ${writeRes.status} ${await writeRes.text()}`)
}

// ---- commit ----
const commitRes = await fetch(`${RUNNER}/workflows/${WORKFLOW}/commit`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    message:
      'Strip dead lineart chain: remove Scribble ControlNet path (LoadImage/ImageInvert/loader/apply), rewire skeleton CN inputs straight to Positive/Negative. H-group verdict: composition lineart never feeds the graph; depth+skeleton only.',
  }),
})
if (!commitRes.ok) {
  throw new Error(`commit failed: ${commitRes.status} ${await commitRes.text()}`)
}
const committed = await commitRes.json()
console.log(`committed ${WORKFLOW} → new version ${committed.version}`)
