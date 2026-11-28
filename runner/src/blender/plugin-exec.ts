import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import type { BlenderTools } from './mcp-tools.ts'
import { RunnerError } from '../errors.ts'

export interface PluginContext {
  vars: Record<string, unknown>
  scene: string | null
  runId: string
  pluginId: string
  outputDir: string
  mcp: BlenderTools
  log(message: string): void
}

type PluginRun = (context: PluginContext) => unknown | Promise<unknown>

// 插件是 data/blender-plugin 下的 .ts 文件。Node 22 直接剥离类型执行，
// 不需要额外的编译步骤，也不需要 Python 解释器。
export async function runPlugin(
  entryPath: string,
  base: Omit<PluginContext, 'log'>,
): Promise<string> {
  if (!existsSync(entryPath)) {
    throw new RunnerError(`插件入口不存在：${entryPath}`, 404)
  }
  let module: { run?: unknown; default?: unknown }
  try {
    module = (await import(pathToFileURL(entryPath).href)) as typeof module
  } catch (err) {
    throw new RunnerError(
      `插件加载失败：${err instanceof Error ? err.message : String(err)}`,
      500,
    )
  }
  const run: PluginRun | null =
    typeof module.run === 'function'
      ? (module.run as PluginRun)
      : typeof module.default === 'function'
        ? (module.default as PluginRun)
        : null
  if (!run) {
    throw new RunnerError('插件未导出 run(ctx) 函数', 500)
  }

  const logs: string[] = []
  const context: PluginContext = {
    ...base,
    log(message: string) {
      logs.push(String(message))
    },
  }
  try {
    await run(context)
  } catch (err) {
    const text = logs.concat(err instanceof Error ? err.message : String(err)).join('\n')
    throw new RunnerError(`插件执行失败：${text}`, 500)
  }
  return logs.join('\n')
}
