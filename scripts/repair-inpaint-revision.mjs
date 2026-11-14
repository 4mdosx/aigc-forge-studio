// 一次性数据修复：spxs2hdl（inpaint_v1 唯一 revision）入库时误传试验格式文件，
// ui_json / api_json 双双存成 blob 脏数据，GET /works/inpaint 与 update 均被
// sameDocument 的 JSON.parse 卡死。用 runner 自己的 promptFromUi 重算正本写回。
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { promptFromUi } from '../runner/src/comfy/prompt.ts'

const uiPath = '/Users/token/workspace/AIGC/experiments/workflows/inpaint_v1.ui.json'
const ui = JSON.parse(readFileSync(uiPath, 'utf8'))
const api = promptFromUi(ui, 'inpaint_v1.ui.json')

const db = new DatabaseSync('/Users/token/workspace/AIGC/aigc-forge-studio/data/runner.sqlite')
const row = db
  .prepare("SELECT id, version, typeof(ui_json) AS t FROM workflow_revisions WHERE version = 'spxs2hdl'")
  .get()
if (!row) throw new Error('revision spxs2hdl not found')

const message = '修复：入库时误传试验格式文件，ui/api 双 blob 脏数据；以本地正本重写（内容等价于 loadGraph 产出）'
db.prepare(
  `UPDATE workflow_revisions
   SET ui_json = ?, api_json = ?, message = ?
   WHERE id = ?`,
).run(JSON.stringify(ui), JSON.stringify(api), message, row.id)

const after = db
  .prepare("SELECT typeof(ui_json) AS ui_type, typeof(api_json) AS api_type, message FROM workflow_revisions WHERE version = 'spxs2hdl'")
  .get()
console.log('before:', row.t, '→ after:', JSON.stringify(after))
console.log('api nodes:', Object.keys(api).join(', '))
