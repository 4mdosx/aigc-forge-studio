import type { Hono } from 'hono'
import { join } from 'node:path'

import { createTools } from '../blender/mcp-tools.ts'
import { runPlugin } from '../blender/plugin-exec.ts'
import {
  listPlugins,
  listSceneTemplates,
  readEntryCode,
  readManifest,
  readSources,
  resolveEntryPath,
} from '../blender/plugins.ts'
import type { BlenderRuntime } from '../blender/runtime.ts'
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
    const template = scene
      ? listSceneTemplates(blender.dataDir).find((item) => item.name === scene)
      : undefined
    try {
      const mcp = createTools(blender)
      if (template) await mcp.scene.open(join(blender.dataDir, 'scenes', template.file))
      if (scene && !template) await mcp.scene.select(scene)
      const log = await runPlugin(resolveEntryPath(blender.dataDir, pluginId), {
        vars: variables,
        scene,
        runId: record.id,
        pluginId,
        outputDir: join(blender.dataDir, 'runs', record.id, 'output'),
        mcp,
      })
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
