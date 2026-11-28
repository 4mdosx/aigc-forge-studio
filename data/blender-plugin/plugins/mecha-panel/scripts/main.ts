import type { BoxSpec, PluginContext } from '../../../types'

export async function run(ctx: PluginContext): Promise<void> {
  const { vars, mcp, log } = ctx
  const count = Number(vars.count ?? 6)
  const width = Number(vars.width ?? 0.8)
  const seed = Number(vars.seed ?? 1)
  const prefix = String(vars.prefix ?? 'Panel')
  const clearExisting = vars.clearExisting === true

  if (clearExisting) await mcp.objects.clear(prefix)

  let state = seed >>> 0
  function random(): number {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }

  const boxes: BoxSpec[] = Array.from({ length: count }, (_, index) => {
    const height = 0.5 + random() * 0.6
    return {
      name: `${prefix}_${String(index + 1).padStart(2, '0')}`,
      location: [index * 1.15, 0, height / 2],
      size: [width / 2, 0.06, height / 2],
      color: [0.9, 0.88, 0.82, 1],
    }
  })

  await mcp.objects.boxes(boxes)
  log(`生成 ${boxes.length} 块面板，前缀 ${prefix}`)
  log(`产物目录 ${ctx.outputDir}`)
}
