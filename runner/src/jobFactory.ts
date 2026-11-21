import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { JOB_KIND, workflowByName } from './db.ts'
import type { AdapterMap } from './workflow/binding.ts'

// 新链路统一的任务写入口：显式传 workflow 名 + 代码内声明的 adapter + payload，
// 取 workflow 的 main head，直接落 jobs 表。不依赖 work / work_workflows / adapter_json。
export interface RawJobInput {
  workflowName: string
  adapter: AdapterMap
  revisionApiJson: string
  revisionId: string
  payload: Record<string, unknown>
  task: string
  label?: string
  parentTaskId?: string | null
  recipeKind?: string
  recipe?: Record<string, unknown>
}

export interface RawJobResult {
  jobId: string
  workflowName: string
  version: string
}

export function createJobRaw(db: DatabaseSync, now: Date, input: RawJobInput): RawJobResult {
  const workflow = workflowByName(db, input.workflowName)
  const id = randomUUID()
  const version = (
    db.prepare('SELECT version FROM workflow_revisions WHERE id = ?').get(input.revisionId) as
      | { version: string }
      | undefined
  )?.version
  if (!version) throw new Error('revision not found')

  const insertJob = db.prepare(
    `INSERT INTO jobs
      (id, kind, status, workflow_name, workflow_id, work_id, comfy_path, adapter_json,
       api_json, head_revision_id, parent_task_id, task, input_json, label, created_at, next_run_at)
     VALUES (?, ?, 'pending', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
  const insertRecipe = db.prepare(
    'INSERT INTO recipes (job_id, kind, input_json, created_at) VALUES (?, ?, ?, ?)',
  )
  db.prepare('BEGIN').run()
  try {
    insertJob.run(
      id,
      JOB_KIND.generate,
      workflow.name,
      workflow.id,
      workflow.comfy_path,
      JSON.stringify(input.adapter),
      input.revisionApiJson,
      input.revisionId,
      input.parentTaskId ?? null,
      input.task,
      JSON.stringify(input.payload),
      input.label ?? '',
      now.getTime(),
    )
    if (input.recipeKind && input.recipe) {
      insertRecipe.run(
        id,
        input.recipeKind,
        JSON.stringify(input.recipe),
        now.getTime(),
      )
    }
    db.prepare('COMMIT').run()
  } catch (err) {
    db.prepare('ROLLBACK').run()
    throw err
  }
  return { jobId: id, workflowName: workflow.name, version }
}
