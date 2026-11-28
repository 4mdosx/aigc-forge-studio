/**
 * 插件脚本的上下文类型。插件是 .ts 文件，由 Runner 直接加载执行；
 * 这里只做类型提示，运行时不会加载这个文件。
 */

export interface BoxSpec {
  name: string
  location: [number, number, number]
  size: [number, number, number]
  color?: [number, number, number, number]
}

export interface RenderOptions {
  resolutionX?: number
  resolutionY?: number
  samples?: number
}

export interface BlenderTools {
  /** 直接调用任意 blender-mcp 工具。 */
  call(name: string, args?: Record<string, unknown>): Promise<string>
  /** 逃生舱：把一段 bpy 代码交给 blender-mcp 的 execute_blender_code。 */
  code(source: string): Promise<string>
  scene: {
    open(filepath: string): Promise<string>
    select(name: string): Promise<string>
  }
  objects: {
    clear(prefix?: string): Promise<string>
    boxes(items: BoxSpec[]): Promise<string>
  }
  render: {
    to(filepath: string, options?: RenderOptions): Promise<string>
  }
}

export interface PluginContext {
  /** 工作台表单注入的变量，键与 manifest.json 的 variables 一致。 */
  vars: Record<string, unknown>
  /** 选中的 Scene 名或模板名；空字符串表示当前 Scene。 */
  scene: string | null
  runId: string
  pluginId: string
  /** 本次运行的产物目录，产物写这里，不要写插件源码目录。 */
  outputDir: string
  /** 通过 MCP 操作 Blender，不直接碰 bpy。 */
  mcp: BlenderTools
  /** 写运行日志。 */
  log(message: string): void
}
