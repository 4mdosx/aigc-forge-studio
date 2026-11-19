import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { WD14_TAGS_FILE } from './cooccur.ts'

// 词表的图片集合来自 image_assets，不扫目录。
// 值保持 "tag1,tag2,"，和 data/wd14-tags.json 原来的读法一致。

export function tagLine(tags: string[]): string {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const raw of tags) {
    const tag = raw.trim()
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    kept.push(tag)
  }
  return kept.length === 0 ? '' : `${kept.join(',')},`
}

export function tagTableFromRows(
  rows: Array<{ id: string; tags_json: string }>,
): Record<string, string> {
  const table: Record<string, string> = {}
  for (const row of rows) {
    if (row.id === '') continue
    table[row.id] = tagLine(tagsOf(row.tags_json))
  }
  return table
}

export function writeWd14TagTable(db: DatabaseSync, dataDir: string): Record<string, string> {
  const rows = db
    .prepare('SELECT id, tags_json FROM image_assets ORDER BY created_at, id')
    .all() as Array<{ id: string; tags_json: string }>
  const table = tagTableFromRows(rows)
  writeFileSync(join(dataDir, WD14_TAGS_FILE), `${JSON.stringify(table, null, 1)}\n`)
  return table
}

function tagsOf(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((tag): tag is string => typeof tag === 'string')
  } catch {
    return []
  }
}
