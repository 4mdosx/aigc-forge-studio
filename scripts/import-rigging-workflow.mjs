#!/usr/bin/env node
// import-rigging-workflow.mjs — 绕过被污染的 GET userdata，直插 DB 建 add_rigging_v1
// 数据源 = refine_v1 head (m0uwxpmw) 的 ui_json/api_json（图完全相同）。
// 前置：备份 data/runner.sqlite；短事务 BEGIN IMMEDIATE + busy_timeout，与 runner 的 1s tick 无锁冲突窗口。
// 跑完立即用 runner API 验证。

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const DB = '/Users/token/workspace/AIGC/aigc-forge-studio/data/runner.sqlite'
const now = new Date().toISOString()

// 0. 备份
const bak = `${DB}.bak-rigging-${Date.now()}`
copyFileSync(DB, bak)
console.log(`backup: ${bak}`)

const db = new DatabaseSync(DB)
db.exec('PRAGMA busy_timeout = 5000')

// 1. 取 refine_v1 head 数据源
const src = db
  .prepare(
    `SELECT r.id, r.version, r.ui_json, r.api_json
     FROM workflow_revisions r
     JOIN workflows w ON w.id = r.workflow_id
     WHERE w.name = 'refine_v1' AND r.version = 'm0uwxpmw'`,
  )
  .get()
if (!src) throw new Error('refine_v1 m0uwxpmw not found')
console.log(`source: refine_v1 m0uwxpmw (${src.ui_json.length}B ui / ${src.api_json.length}B api)`)

// 2. 生成版本号（首字母 + 7 位 [a-z0-9]，与 allocateVersion 同字符集）
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
function newVersion() {
  for (;;) {
    let v = LETTERS[Math.floor(Math.random() * 26)]
    for (let i = 0; i < 7; i++) v += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
    const hit = db.prepare('SELECT 1 FROM workflow_revisions WHERE version = ?').get(v)
    if (!hit) return v
  }
}
const version = newVersion()
const revisionId = randomUUID()
const workflowId = randomUUID()

// 3. adapter_json：复制 refine_v1 绑定并挂新版本键（借用逻辑跨 workflow 不生效）
const refineWorkId = db.prepare(`SELECT id FROM works WHERE name = 'refine'`).get().id
const refineLink = db
  .prepare(
    `SELECT ww.adapter_json FROM work_workflows ww
     JOIN workflows w ON w.id = ww.workflow_id
     WHERE ww.work_id = ? AND w.name = 'refine_v1'`,
  )
  .get(refineWorkId)
if (!refineLink) throw new Error('refine work is not linked to refine_v1')
const adapterMap = JSON.parse(refineLink.adapter_json)
// 用最新版本的 adapter 条目（resolveAdapter 借用语义下 head 实际生效的那份）
const latestKey = Object.keys(adapterMap).at(-1)
adapterMap[version] = adapterMap[latestKey]
console.log(`adapter: copied from key ${latestKey} -> ${version}`)

// 4. 短事务插入
db.exec('BEGIN IMMEDIATE')
try {
  db.prepare(
    `INSERT INTO workflows (id, name, comfy_path, current_branch, created_at)
     VALUES (?, 'add_rigging_v1', 'workflows/add_rigging_v1.json', 'main', ?)`,
  ).run(workflowId, now)
  db.prepare(
    `INSERT INTO workflow_revisions (id, workflow_id, version, ui_json, api_json, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    revisionId,
    workflowId,
    version,
    src.ui_json,
    src.api_json,
    '从 refine_v1 (m0uwxpmw) 复制：uncanny + euler_ancestral/normal/28/cfg5，denoise 参数化。目的 = 给底图添加舰装（azur lane rigging），prompt 由调用方携带 rigging 锚词。绕过被代理污染的 GET userdata，DB 直插建库（GET 通路恢复后可 POST /comfy/workflows sync 校验一致性）。',
    now,
  )
  db.prepare(
    `INSERT INTO workflow_branches (workflow_id, name, head_revision_id) VALUES (?, 'main', ?)`,
  ).run(workflowId, revisionId)
  db.prepare(
    `INSERT INTO work_workflows (work_id, workflow_id, adapter_json) VALUES (?, ?, ?)`,
  ).run(refineWorkId, workflowId, JSON.stringify(adapterMap))
  db.exec('COMMIT')
  console.log(`inserted: workflow ${workflowId} version ${version} -> work refine`)
} catch (err) {
  try { db.exec('ROLLBACK') } catch { /* 事务已被 SQLite 隐式回滚 */ }
  console.error('insert failed:', err.message)
  throw err
} finally {
  db.close()
}

// 5. 打印验证指引
console.log(`\nverify: curl -s http://127.0.0.1:8787/works/refine | 检查 add_rigging_v1 出现且 versions[0].hasAdapter=true`)
