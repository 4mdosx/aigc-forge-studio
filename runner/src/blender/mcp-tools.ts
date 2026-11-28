import type { BlenderRuntime } from './runtime.ts'

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

// 插件脚本看到的 MCP 能力面。插件只写 TypeScript，bpy 调用由这层生成。
export interface BlenderTools {
  call(name: string, args?: Record<string, unknown>): Promise<string>
  code(code: string): Promise<string>
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

export function createTools(runtime: BlenderRuntime): BlenderTools {
  async function call(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<string> {
    const result = (await runtime.callTool(name, args)) as {
      content?: unknown
      isError?: boolean
    }
    const text = textOf(result.content)
    if (result.isError || /^(Error executing code|Error:)/.test(text.trim())) {
      throw new Error(`Blender 工具 ${name} 失败：${text.trim()}`)
    }
    return text
  }

  async function code(source: string): Promise<string> {
    return call('execute_blender_code', {
      code: source,
      user_prompt: 'aigc-runner plugin execution',
    })
  }

  // 参数走 base64 JSON 注入，避免变量里的引号/换行破坏代码串。
  function payload(value: unknown): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
  }

  return {
    call,
    code,
    scene: {
      async open(filepath: string) {
        return code(`import bpy, base64
bpy.ops.wm.open_mainfile(filepath=base64.b64decode('${payload(filepath)}').decode('utf-8'))`)
      },
      async select(name: string) {
        return code(`import bpy, base64
name = base64.b64decode('${payload(name)}').decode('utf-8')
if name not in bpy.data.scenes:
    raise RuntimeError('scene not found: ' + name)
bpy.context.window.scene = bpy.data.scenes[name]`)
      },
    },
    objects: {
      async clear(prefix = '') {
        return code(`import bpy, base64
prefix = base64.b64decode('${payload(prefix)}').decode('utf-8')
removed = 0
for obj in list(bpy.data.objects):
    if prefix == '' or obj.name.startswith(prefix):
        bpy.data.objects.remove(obj, do_unlink=True)
        removed += 1
print(removed)`)
      },
      async boxes(items: BoxSpec[]) {
        if (items.length === 0) return ''
        return code(`import bpy, json, base64
items = json.loads(base64.b64decode('${payload(items)}').decode('utf-8'))
for item in items:
    bpy.ops.mesh.primitive_cube_add(size=1, location=tuple(item['location']))
    obj = bpy.context.object
    obj.name = item['name']
    obj.scale = tuple(item['size'])
    color = item.get('color')
    if color:
        mat = bpy.data.materials.new(name=item['name'] + '_mat')
        mat.diffuse_color = tuple(color)
        obj.data.materials.append(mat)
print(len(items))`)
      },
    },
    render: {
      async to(filepath: string, options: RenderOptions = {}) {
        return code(`import bpy, base64, json
path = base64.b64decode('${payload(filepath)}').decode('utf-8')
opts = json.loads(base64.b64decode('${payload(options)}').decode('utf-8'))
scene = bpy.context.scene
if 'resolutionX' in opts: scene.render.resolution_x = int(opts['resolutionX'])
if 'resolutionY' in opts: scene.render.resolution_y = int(opts['resolutionY'])
if 'samples' in opts:
    if hasattr(scene, 'cycles'): scene.cycles.samples = int(opts['samples'])
scene.render.filepath = path
bpy.ops.render.render(write_still=True)
print(path)`)
      },
    },
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
