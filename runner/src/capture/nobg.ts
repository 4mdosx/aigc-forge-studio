import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { branchOf, revisionById, workflowByName } from '../db.ts'
import { RunnerError } from '../errors.ts'
import {
  assertSuccess,
  filesFromHistory,
  pollUntilDone,
} from '../comfy/client.ts'
import type { Prompt } from '../workflow/graph.ts'
import type { Runner } from '../task/queue.ts'
import { assetById, pixelSize } from './asset.ts'

const WORKFLOW = 'RM_BG'
const SAVE_TYPES = new Set(['SaveImage', 'SaveImageAdvanced'])

export function cutoutPrompt(source: Prompt, imagePath: string, prefix: string): Prompt {
  const prompt = structuredClone(source)
  const loaders = Object.values(prompt).filter((node) => node.class_type === 'LoadImage')
  if (loaders.length !== 1) throw new RunnerError('RM_BG 需要恰好一个 LoadImage')
  const loader = loaders[0]
  if (!loader || !Object.hasOwn(loader.inputs, 'image')) {
    throw new RunnerError('RM_BG 的 LoadImage 没有 image 输入')
  }
  loader.inputs.image = imagePath
  const saves = Object.values(prompt).filter((node) => SAVE_TYPES.has(node.class_type))
  if (saves.length !== 1) throw new RunnerError('RM_BG 需要恰好一个保存节点')
  const save = saves[0]
  if (!save || !Object.hasOwn(save.inputs, 'filename_prefix')) {
    throw new RunnerError('RM_BG 的保存节点没有 filename_prefix')
  }
  save.inputs.filename_prefix = prefix
  return prompt
}

export async function removeBackground(runner: Runner, id: string) {
  const asset = assetById(runner.db, id)
  if (!asset) throw new RunnerError('image not found', 404)
  if (asset.status === 'approved') throw new RunnerError('已通过的图片不再移除背景', 409)
  if (!asset.processed) throw new RunnerError('没有处理后的图片', 409)
  const client = runner.clients[0]
  if (!client) throw new RunnerError('no ComfyUI instance')

  const workflow = workflowByName(runner.db, WORKFLOW)
  const branch = branchOf(runner.db, workflow.id, workflow.current_branch)
  const revision = revisionById(runner.db, branch.head_revision_id)
  const source = JSON.parse(revision.api_json) as Prompt
  const hash = asset.original.hash
  const sub = `capture/${hash}`
  const bytes = readFileSync(join(runner.dataDir, asset.processed.path))
  await client.uploadBytes(new Uint8Array(bytes), 'source.png', sub)
  const prompt = cutoutPrompt(source, `${sub}/source.png`, `capture-nobg/${asset.id}`)
  const promptId = await client.submitPrompt(prompt)
  const entry = await pollUntilDone({
    poll: () => client.promptHistory(promptId),
    timeoutMs: runner.timeoutMs,
  })
  assertSuccess(entry)
  const saveIds = new Set(
    Object.entries(prompt)
      .filter(([, node]) => SAVE_TYPES.has(node.class_type))
      .map(([nodeId]) => nodeId),
  )
  const file = filesFromHistory(entry).find((item) => saveIds.has(item.nodeId))
  if (!file) throw new RunnerError('移除背景没有产出图片')
  const viewed = await client.viewFile(file.type, file.subfolder, file.filename)
  if (viewed.bytes.byteLength === 0) throw new RunnerError('移除背景没有产出图片')

  const root = asset.processed.path.startsWith('capture/assets/') ? 'assets' : 'raw'
  const nobgRel = `capture/${root}/${hash}/nobg.png`
  const nobgAbs = join(runner.dataDir, nobgRel)
  writeFileSync(nobgAbs, viewed.bytes)
  const size = await pixelSize(nobgAbs)
  runner.db
    .prepare(
      `UPDATE image_assets SET nobg_path = ?, nobg_width = ?, nobg_height = ?, updated_at = ? WHERE id = ?`,
    )
    .run(nobgRel, size.width, size.height, runner.now().getTime(), id)
  const next = assetById(runner.db, id)
  if (!next) throw new RunnerError('image not found', 404)
  return next
}
