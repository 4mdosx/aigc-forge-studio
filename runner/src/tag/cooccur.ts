// 图库 WD14 标签 → 共现计数。推荐按条件概率排序，不做字段分组。
// 表只留共同出现不少于 2 次的配对。分数在查询时由 count、df 现算。

export const WD14_TAGS_FILE = 'wd14-tags.json'
export const RECOMMEND_LIMIT = 10

const MIN_PAIR_COUNT = 2
const POOL = 40
const TAU_SCALE = 0.4

export interface CooccurIndex {
  n: number
  df: Map<string, number>
  pairs: Map<string, Map<string, number>>
}

export function normalizeTag(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '_')
}

// 逗号分隔，去空去重。末尾多写的逗号留出空段，直接丢掉。
export function parseTagList(text: string): string[] {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const raw of text.split(',')) {
    const tag = normalizeTag(raw)
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
  }
  return tags
}

export function readTagTable(text: string): Record<string, string> {
  const raw: unknown = JSON.parse(text)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('wd14-tags.json must be an object of filename → tag string')
  }
  const docs: Record<string, string> = {}
  for (const [file, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new Error(
        `wd14-tags.json: "${file}" must be a comma-separated tag string`,
      )
    }
    docs[file] = value
  }
  return docs
}

export function buildCooccur(docs: Record<string, string>): CooccurIndex {
  const df = new Map<string, number>()
  const pairs = new Map<string, Map<string, number>>()
  let n = 0
  for (const value of Object.values(docs)) {
    const tags = parseTagList(value)
    if (tags.length === 0) continue
    n += 1
    for (const tag of tags) df.set(tag, (df.get(tag) ?? 0) + 1)
    for (let i = 0; i < tags.length; i += 1) {
      for (let j = i + 1; j < tags.length; j += 1) {
        addPair(pairs, tags[i] as string, tags[j] as string)
        addPair(pairs, tags[j] as string, tags[i] as string)
      }
    }
  }
  for (const [tag, partners] of pairs) {
    for (const [other, count] of partners) {
      if (count < MIN_PAIR_COUNT) partners.delete(other)
    }
    if (partners.size === 0) pairs.delete(tag)
  }
  return { n, df, pairs }
}

function addPair(
  pairs: Map<string, Map<string, number>>,
  a: string,
  b: string,
): void {
  let partners = pairs.get(a)
  if (!partners) {
    partners = new Map()
    pairs.set(a, partners)
  }
  partners.set(b, (partners.get(b) ?? 0) + 1)
}

export interface RecommendOptions {
  weights?: Record<string, number>
  random?: () => number
  limit?: number
}

// 查询词各记权重 1（重复词不叠加）。weights 再按 tag 加上去，负值压低其近邻。
// 分数 = Σ 权重 × (共同出现次数 / 查询词出现次数) × log(共同出现次数 + 1)。
// 出现 20 次的查询词里有 12 次跟着的词，会排在只共同出现 2 次的词前面。
// 出现在一半以上图里的词不进结果。查询词和权重里出现过的词也不进。
// 先留分数最高的 40 个，再加 Gumbel 噪声取前 limit 个。
export function recommendTags(
  index: CooccurIndex,
  tags: string[],
  options: RecommendOptions = {},
): string[] {
  const random = options.random ?? Math.random
  const limit = options.limit ?? RECOMMEND_LIMIT
  const context = new Map<string, number>()
  for (const raw of tags) {
    for (const tag of parseTagList(raw)) {
      if (!context.has(tag)) context.set(tag, 1)
    }
  }
  for (const [raw, weight] of Object.entries(options.weights ?? {})) {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight === 0)
      continue
    const tag = normalizeTag(raw)
    if (tag === '') continue
    context.set(tag, (context.get(tag) ?? 0) + weight)
  }

  const blocked = new Set(context.keys())
  const scores = new Map<string, number>()
  for (const [query, weight] of context) {
    const partners = index.pairs.get(query)
    const qdf = index.df.get(query) ?? 0
    if (!partners || qdf === 0 || index.n === 0 || weight === 0) continue
    for (const [tag, count] of partners) {
      if (blocked.has(tag)) continue
      const tdf = index.df.get(tag) ?? 0
      if (tdf === 0 || tdf * 2 > index.n) continue
      const association = (count / qdf) * Math.log(count + 1)
      scores.set(tag, (scores.get(tag) ?? 0) + weight * association)
    }
  }

  const ranked = [...scores.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )
  const pool = ranked.slice(0, POOL)
  if (pool.length === 0) return []
  const tau = TAU_SCALE * stdev(pool.map(([, score]) => score))
  const noisy = pool.map(([tag, score]) => ({
    tag,
    score: score + tau * gumbel(random),
  }))
  noisy.sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag))
  return noisy.slice(0, limit).map((item) => item.tag)
}

function gumbel(random: () => number): number {
  const u = Math.min(1 - 1e-12, Math.max(1e-12, random()))
  return -Math.log(-Math.log(u))
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}
