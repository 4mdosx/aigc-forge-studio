import type { Hono } from 'hono'
import { join } from 'node:path'

import type { BlenderRuntime } from '../blender/runtime.ts'
import {
  listPlugins,
  listSceneTemplates,
  readEntryCode,
  readManifest,
  readSources,
} from '../blender/plugins.ts'
import {
  finishRun,
  getRun,
  listRuns,
  startRun,
} from '../blender/runs.ts'
import { RunnerError } from '../errors.ts'
import { jsonObject, stringField } from './request.ts'

export function mountBlender(app: Hono, blender: BlenderRuntime): void {
  app.get('/blender/status', async (c) => {
    try {
      return c.json(await blender.status())
    } catch (err) {
      return c.json(
        {
          connected: false,
          scenes: [],
          activeScene: null,
          filepath: '',
          error: err instanceof Error ? err.message : String(err),
        },
        200,
      )
    }
  })

  app.get('/blender/plugins', (c) => c.json({ plugins: listPlugins(blender.dataDir) }))

  app.get('/blender/plugins/:id', (c) => {
    const id = c.req.param('id')
    const manifest = readManifest(blender.dataDir, id)
    return c.json({ manifest, sources: readSources(blender.dataDir, id) })
  })

  app.get('/blender/plugins/:id/code', (c) => {
    const id = c.req.param('id')
    const file = c.req.query('file')
    if (!file) return c.json({ path: 'entry', content: readEntryCode(blender.dataDir, id) })
    const found = readSources(blender.dataDir, id).find((item) => item.path === file)
    if (!found) throw new RunnerError(`source not found: ${file}`, 404)
    return c.json(found)
  })

  app.get('/blender/scenes', async (c) => {
    let current
    try {
      current = await blender.status()
    } catch {
      current = null
    }
    return c.json({
      active: current?.activeScene ?? null,
      scenes: current?.scenes ?? [],
      templates: listSceneTemplates(blender.dataDir),
      filepath: current?.filepath ?? '',
    })
  })

  app.post('/blender/run', async (c) => {
    const body = await jsonObject(c.req)
    const pluginId = stringField(body, 'pluginId')
    const manifest = readManifest(blender.dataDir, pluginId)
    const scene = typeof body.scene === 'string' && body.scene !== '' ? body.scene : null
    const variables = normalizeVariables(manifest.variables, body.variables)
    const repoRoot = join(blender.dataDir, '..', '..')
    const record = startRun(blender.dataDir, {
      pluginId,
      scene,
      variables,
      repoRoot,
    })
    const code = buildCode({
      source: readEntryCode(blender.dataDir, pluginId),
      entry: manifest.entry,
      variables,
      run: record,
      scene,
      templatePath: scene
        ? listSceneTemplates(blender.dataDir).find((item) => item.name === scene)?.file
        : undefined,
      dataDir: blender.dataDir,
    })
    try {
      const log = await blender.execute(code)
      return c.json(finishRun(blender.dataDir, record.id, { status: 'ok', log }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const failed = finishRun(blender.dataDir, record.id, {
        status: 'error',
        error: message,
      })
      return c.json(failed, 502)
    }
  })

  app.get('/blender/runs', (c) => {
    const limitRaw = Number(c.req.query('limit'))
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 30
    return c.json({ runs: listRuns(blender.dataDir, limit) })
  })

  app.get('/blender/runs/:id', (c) => c.json(getRun(blender.dataDir, c.req.param('id'))))
}

function normalizeVariables(
  schema: ReturnType<typeof readManifest>['variables'],
  input: unknown,
): Record<string, unknown> {
  const raw = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}
  const result: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(schema)) {
    let value = raw[key] ?? spec.default
    if (spec.type === 'number') {
      const number = Number(value)
      if (!Number.isFinite(number)) throw new RunnerError(`变量 ${key} 必须是数字`, 400)
      if (typeof spec.min === 'number' && number < spec.min)
        throw new RunnerError(`变量 ${key} 不能小于 ${spec.min}`, 400)
      if (typeof spec.max === 'number' && number > spec.max)
        throw new RunnerError(`变量 ${key} 不能大于 ${spec.max}`, 400)
      value = number
    } else if (spec.type === 'boolean') {
      value = value === true || value === 'true'
    } else {
      const text = String(value ?? '')
      if (
        spec.type === 'select' &&
        Array.isArray(spec.options) &&
        !spec.options.includes(text)
      ) {
        throw new RunnerError(`变量 ${key} 不在可选项里`, 400)
      }
      value = text
    }
    result[key] = value
  }
  return result
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

interface BuildInput {
  source: string
  entry: string
  variables: Record<string, unknown>
  run: { id: string; outputDir: string; pluginId: string; scene: string | null }
  scene: string | null
  templatePath?: string
  dataDir: string
}

function buildCode(input: BuildInput): string {
  const vars = b64(JSON.stringify(input.variables))
  const ctx = b64(
    JSON.stringify({
      runId: input.run.id,
      pluginId: input.run.pluginId,
      scene: input.scene,
      outputDir: join(input.dataDir, 'runs', input.run.id, 'output'),
    }),
  )
  const source = b64(input.source)
  const template = input.templatePath
    ? b64(join(input.dataDir, 'scenes', input.templatePath))
    : null
  const scene = input.scene && !input.templatePath ? b64(input.scene) : null
  return `import base64, json, os, bpy
def _decode(value):
    return base64.b64decode(value).decode('utf-8')
VARS = json.loads(_decode('${vars}'))
CTX = json.loads(_decode('${ctx}'))
${template ? `bpy.ops.wm.open_mainfile(filepath=_decode('${template}'))` : ''}
${scene ? `scene_name = _decode('${scene}')
if scene_name not in bpy.data.scenes:
    raise RuntimeError('scene not found: ' + scene_name)
bpy.context.window.scene = bpy.data.scenes[scene_name]` : ''}
exec(compile(_decode('${source}'), '${input.entry.replaceAll("'", "")}', 'exec'), globals())
`
}
