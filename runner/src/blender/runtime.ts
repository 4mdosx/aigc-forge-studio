import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { resolve } from 'node:path'

import type { BlenderConfig } from '../config.ts'
import { RunnerError } from '../errors.ts'

export interface BlenderScene {
  name: string
  active: boolean
  filepath: string
}

export interface BlenderStatus {
  connected: boolean
  scenes: BlenderScene[]
  activeScene: string | null
  filepath: string
}

export interface BlenderRuntime {
  readonly dataDir: string
  readonly config: BlenderConfig
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>
  execute(code: string): Promise<string>
  status(): Promise<BlenderStatus>
  close(): Promise<void>
}

// 一个 runner 进程只开一个 blender-mcp stdio 子进程；Blender add-on 的 socket
// 同时只接一个客户端，所以调用还要串行化。断线时置空，下次调用自动重连。
export function createBlenderRuntime(
  config: BlenderConfig,
  repoRoot: string,
): BlenderRuntime {
  let client: Client | null = null
  let connecting: Promise<Client> | null = null
  let tail: Promise<unknown> = Promise.resolve()

  async function connect(): Promise<Client> {
    if (client) return client
    if (connecting) return connecting
    connecting = (async () => {
      const next = new Client({
        name: 'aigc-runner-blender',
        version: '1.0.0',
      })
      const env: Record<string, string> = {}
      for (const [key, item] of Object.entries(process.env)) {
        if (item !== undefined) env[key] = item
      }
      Object.assign(env, config.env)
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env,
      })
      try {
        await next.connect(transport)
      } catch (err) {
        throw new RunnerError(
          `blender-mcp 启动失败：${err instanceof Error ? err.message : String(err)}`,
          502,
        )
      }
      client = next
      connecting = null
      return next
    })()
    try {
      return await connecting
    } catch (err) {
      connecting = null
      throw err
    }
  }

  async function drop(): Promise<void> {
    const current = client
    client = null
    connecting = null
    if (current) await current.close().catch(() => undefined)
  }

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task, task)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async function callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    return serialize(async () => {
      const current = await connect()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RunnerError('blender-mcp 调用超时', 504)),
          config.timeout * 1000,
        )
      })
      try {
        return await Promise.race([
          current.callTool({ name, arguments: args }),
          timeout,
        ])
      } catch (err) {
        if (err instanceof RunnerError) {
          if (err.status === 504) await drop()
          throw err
        }
        await drop()
        throw new RunnerError(
          `Blender 工具 ${name} 调用失败：${err instanceof Error ? err.message : String(err)}`,
          502,
        )
      } finally {
        if (timer) clearTimeout(timer)
      }
    })
  }

  async function execute(code: string): Promise<string> {
    const result = await callTool('execute_blender_code', {
      code,
      user_prompt: 'aigc-runner plugin execution',
    })
    const value = result as { content?: unknown; isError?: boolean }
    const text = textOf(value.content)
    // blender-mcp 的 execute_blender_code 把异常吞成普通文本返回，isError 仍是 false。
    // 不认这层，工作台会把「连不上 Blender」显示成「已连接但没 Scene」。
    if (value.isError || /^(Error executing code|Error:)/.test(text.trim())) {
      throw new RunnerError(`Blender 执行失败：${text.trim()}`, 500)
    }
    return text
  }

  return {
    dataDir: resolve(repoRoot, config.dataDir),
    config,
    callTool,
    execute,
    async status(): Promise<BlenderStatus> {
      const code = `import bpy, json
print(json.dumps({
  "scenes": [{"name": s.name, "active": s.name == bpy.context.scene.name} for s in bpy.data.scenes],
  "filepath": bpy.data.filepath
}))`
      const raw = await execute(code)
      const payload = extractJson(raw)
      if (!payload) {
        throw new RunnerError('无法读取 Blender Scene，检查 add-on 是否已启动', 502)
      }
      const scenes: BlenderScene[] = Array.isArray(payload?.scenes)
        ? (payload.scenes as Array<Record<string, unknown>>).map((item) => ({
            name: String(item.name ?? ''),
            active: item.active === true,
            filepath: String(payload?.filepath ?? ''),
          }))
        : []
      return {
        connected: true,
        scenes,
        activeScene: scenes.find((item) => item.active)?.name ?? null,
        filepath: String(payload?.filepath ?? ''),
      }
    },
    close: drop,
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((item) =>
      item && typeof item === 'object' && 'text' in item
        ? String((item as { text: unknown }).text)
        : '',
    )
    .join('\n')
}

// execute_blender_code 的返回形如 "Code executed successfully: {json}\n"
function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}
