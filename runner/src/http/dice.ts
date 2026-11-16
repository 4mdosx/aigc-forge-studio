import type { Hono } from 'hono'

import { RunnerError } from '../errors.ts'
import { DEFAULT_DICE_FIELDS, transaction } from '../db.ts'
import type { Runner } from '../task/queue.ts'
import { jsonObject } from './request.ts'

// dice 掷骰工作台：prompt 模版字段池存 SQLite（dice_fields 表）。
// GET 全量按 position 排序；PUT 全量替换（事务内 delete+insert，改名/删字段/调序都走它）。

interface DiceFieldInput {
  name: string
  values: string
  count: number
}

function parseFields(raw: unknown): DiceFieldInput[] {
  if (!Array.isArray(raw)) throw new RunnerError('fields must be an array')
  const seen = new Set<string>()
  const rows: DiceFieldInput[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new RunnerError('each field must be an object')
    }
    const body = item as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name === '') throw new RunnerError('field name is required')
    if (name.length > 64) throw new RunnerError('field name too long (max 64)')
    const values = typeof body.values === 'string' ? body.values : ''
    const count = Number(body.count)
    if (!Number.isInteger(count) || count < 0 || count > 99) {
      throw new RunnerError(`field ${name}: count must be an integer 0..99`)
    }
    if (seen.has(name)) throw new RunnerError(`duplicate field name: ${name}`)
    seen.add(name)
    rows.push({ name, values, count })
  }
  return rows
}

export function mountDice(app: Hono, runner: Runner): void {
  app.get('/dice/fields', (c) => {
    const rows = runner.db
      .prepare('SELECT name, candidates AS "values", count FROM dice_fields ORDER BY position, id')
      .all()
    return c.json({ fields: rows })
  })

  // 重置为种子默认集：清空后按 DEFAULT_DICE_FIELDS 重建
  app.post('/dice/reset', (c) => {
    transaction(runner.db, () => {
      runner.db.prepare('DELETE FROM dice_fields').run()
      const insert = runner.db.prepare(
        'INSERT INTO dice_fields (name, candidates, count, position) VALUES (?, ?, ?, ?)',
      )
      for (const [index, field] of DEFAULT_DICE_FIELDS.entries()) {
        insert.run(field.name, field.values, field.count, index)
      }
    })
    return c.json({ reset: DEFAULT_DICE_FIELDS.length })
  })

  app.put('/dice/fields', async (c) => {
    const body = await jsonObject(c.req)
    const rows = parseFields(body.fields)
    transaction(runner.db, () => {
      runner.db.prepare('DELETE FROM dice_fields').run()
      const insert = runner.db.prepare(
        'INSERT INTO dice_fields (name, candidates, count, position) VALUES (?, ?, ?, ?)',
      )
      for (const [index, row] of rows.entries()) {
        insert.run(row.name, row.values, row.count, index)
      }
    })
    return c.json({ saved: rows.length })
  })
}
