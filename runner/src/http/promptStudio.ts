import { existsSync, readFileSync } from 'node:fs'
import type { Hono } from 'hono'
import { join } from 'node:path'

import { RunnerError } from '../errors.ts'
import {
  cleanLlmText,
  groupsFrom,
  joinGroups,
  RECOMPOSE_SYSTEM,
  recomposeCanonical,
  splitPrompt,
  type CanonicalTable,
} from '../prompt/studio.ts'
import type { Runner } from '../task/queue.ts'
import { jsonObject, stringField } from './request.ts'

const TABLE_FILE = 'prompt-canonical.json'

function loadTable(dataDir: string): CanonicalTable {
  const path = join(dataDir, TABLE_FILE)
  if (!existsSync(path)) throw new RunnerError(`canonical table missing: ${path}`, 404)
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CanonicalTable
  } catch (err) {
    throw new RunnerError(
      `invalid canonical table: ${err instanceof Error ? err.message : String(err)}`,
      500,
    )
  }
}

// 首页 prompt 工作台：拆分（纯规则）+ 重组（LLM / canonical 两模式）。
// 只服务首页 QuickGenerate，不动项目其他结构化 prompt 链路。
export function mountPromptStudio(app: Hono, runner: Runner): void {
  app.get('/prompt/canonical', (c) => c.json(loadTable(runner.dataDir)))

  // 平铺 prompt → 四组（触发词与质量 / 外貌与身份 / 服装与题材 / 姿势与构图）
  app.post('/prompt/split', async (c) => {
    const body = await jsonObject(c.req)
    const text = stringField(body, 'text')
    const groups = splitPrompt(text)
    return c.json({ groups, joined: joinGroups(groups) })
  })

  // 重组：mode=llm 走 chat gateway 一次做完去重+重组；mode=canonical 走可维护表（确定性）
  app.post('/prompt/recompose', async (c) => {
    const body = await jsonObject(c.req)
    const mode = body.mode === 'llm' ? 'llm' : 'canonical'
    let groups
    try {
      groups = groupsFrom(body.groups)
    } catch (err) {
      throw new RunnerError(err instanceof Error ? err.message : String(err))
    }

    if (mode === 'canonical') {
      const table = loadTable(runner.dataDir)
      return c.json({
        mode,
        theme: table.theme,
        text: recomposeCanonical(groups, table),
      })
    }

    // llm
    if (!runner.chat) throw new RunnerError('chat gateway is not configured', 503)
    const model =
      typeof body.model === 'string' && body.model !== ''
        ? body.model
        : runner.chat.models[0]
    const input = joinGroups(groups)
    const raw = await runner.chat.complete(
      model,
      [{ role: 'user', content: input }],
      RECOMPOSE_SYSTEM,
    )
    return c.json({ mode, model, text: cleanLlmText(raw) })
  })
}
