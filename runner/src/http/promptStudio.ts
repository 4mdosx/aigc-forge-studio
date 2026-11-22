import { existsSync, readFileSync } from 'node:fs'
import type { Hono } from 'hono'
import { join } from 'node:path'

import { RunnerError } from '../errors.ts'
import {
  cleanLlmText,
  groupsFrom,
  joinGroups,
  parseThemeDraft,
  RECOMPOSE_SYSTEM,
  recomposeBank,
  splitPrompt,
  THEME_TABLE_SYSTEM,
  type CanonicalBank,
} from '../prompt/studio.ts'
import type { Runner } from '../task/queue.ts'
import { jsonObject, stringField } from './request.ts'

const TABLE_FILE = 'prompt-canonical.json'

function loadBank(dataDir: string): CanonicalBank {
  const path = join(dataDir, TABLE_FILE)
  if (!existsSync(path)) throw new RunnerError(`canonical bank missing: ${path}`, 404)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CanonicalBank
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      parsed.global === undefined ||
      parsed.themes === undefined ||
      typeof parsed.themes !== 'object'
    ) {
      throw new Error('缺少 global / themes 字段（旧单表结构？）')
    }
    return parsed
  } catch (err) {
    throw new RunnerError(
      `invalid canonical bank: ${err instanceof Error ? err.message : String(err)}`,
      500,
    )
  }
}

// 首页 prompt 工作台：拆分（纯规则）+ 重组（LLM / canonical bank 两模式）。
// 只服务首页 QuickGenerate，不动项目其他结构化 prompt 链路。
export function mountPromptStudio(app: Hono, runner: Runner): void {
  app.get('/prompt/canonical', (c) => c.json(loadBank(runner.dataDir)))

  // 平铺 prompt → 四组（触发词与质量 / 外貌与身份 / 服装与题材 / 姿势与构图）
  app.post('/prompt/split', async (c) => {
    const body = await jsonObject(c.req)
    const text = stringField(body, 'text')
    const groups = splitPrompt(text)
    return c.json({ groups, joined: joinGroups(groups) })
  })

  // 给定一串 WD14 tag，让 LLM 产出一张题材表草案（JSON），不写入 bank。
  // 人审过再手动并入 data/prompt-canonical.json。
  app.post('/prompt/theme-from-tags', async (c) => {
    const body = await jsonObject(c.req)
    const tags = stringField(body, 'tags')
    if (!runner.chat) throw new RunnerError('chat gateway is not configured', 503)
    const model =
      typeof body.model === 'string' && body.model !== ''
        ? body.model
        : runner.chat.models[0]
    const raw = await runner.chat.complete(
      model,
      [{ role: 'user', content: tags }],
      THEME_TABLE_SYSTEM,
    )
    const cleaned = cleanLlmText(raw)
    let table
    try {
      table = parseThemeDraft(cleaned)
    } catch (err) {
      throw new RunnerError(
        `LLM 题材表草案不合法：${err instanceof Error ? err.message : String(err)}`,
        502,
      )
    }
    return c.json({ mode: 'theme-draft', model, table, raw: cleaned })
  })

  // 重组：mode=llm 走 chat gateway 一次做完去重+重组；mode=canonical 走表库（确定性）
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
      const bank = loadBank(runner.dataDir)
      const result = recomposeBank(groups, bank)
      return c.json({
        mode,
        theme: result.themeId,
        themeLabel: result.themeId ?? 'global（托底）',
        text: result.text,
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
