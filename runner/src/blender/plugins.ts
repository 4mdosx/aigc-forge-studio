import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { RunnerError } from '../errors.ts'

export interface PluginVariable {
  type: 'number' | 'string' | 'boolean' | 'select'
  label?: string
  default?: unknown
  min?: number
  max?: number
  step?: number
  options?: string[]
}

export interface PluginManifest {
  id: string
  name: string
  description: string
  entry: string
  files: string[]
  variables: Record<string, PluginVariable>
}

export interface PluginSummary {
  id: string
  name: string
  description: string
  variables: Record<string, PluginVariable>
}

export interface SceneTemplate {
  name: string
  file: string
}

function pluginDir(dataDir: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new RunnerError(`invalid plugin id: ${id}`, 400)
  }
  return join(dataDir, 'plugins', id)
}

function safePath(base: string, name: string): string {
  const target = resolve(base, name)
  if (target !== base && !target.startsWith(base + sep)) {
    throw new RunnerError(`path outside plugin directory: ${name}`, 400)
  }
  return target
}

export function readManifest(dataDir: string, id: string): PluginManifest {
  const path = join(pluginDir(dataDir, id), 'manifest.json')
  if (!existsSync(path)) throw new RunnerError(`plugin not found: ${id}`, 404)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new RunnerError(
      `invalid manifest for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      500,
    )
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RunnerError(`invalid manifest for ${id}`, 500)
  }
  const value = raw as Record<string, unknown>
  const entry = typeof value.entry === 'string' ? value.entry : ''
  if (entry === '') throw new RunnerError(`manifest ${id} missing entry`, 500)
  const files = Array.isArray(value.files)
    ? value.files.filter((item): item is string => typeof item === 'string')
    : [entry]
  const variables: Record<string, PluginVariable> = {}
  if (value.variables && typeof value.variables === 'object') {
    for (const [key, item] of Object.entries(value.variables)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const spec = item as Record<string, unknown>
      if (
        spec.type === 'number' ||
        spec.type === 'string' ||
        spec.type === 'boolean' ||
        spec.type === 'select'
      ) {
        variables[key] = spec as unknown as PluginVariable
      }
    }
  }
  return {
    id,
    name: typeof value.name === 'string' ? value.name : id,
    description:
      typeof value.description === 'string' ? value.description : '',
    entry,
    files: files.includes(entry) ? files : [entry, ...files],
    variables,
  }
}

export function listPlugins(dataDir: string): PluginSummary[] {
  const root = join(dataDir, 'plugins')
  if (!existsSync(root)) return []
  const result: PluginSummary[] = []
  for (const name of readdirSync(root).sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) continue
    if (!existsSync(join(root, name, 'manifest.json'))) continue
    const manifest = readManifest(dataDir, name)
    result.push({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      variables: manifest.variables,
    })
  }
  return result
}

export interface SourceFile {
  path: string
  content: string
}

export function readSources(dataDir: string, id: string): SourceFile[] {
  const manifest = readManifest(dataDir, id)
  const base = pluginDir(dataDir, id)
  const result: SourceFile[] = []
  for (const name of manifest.files) {
    const path = safePath(base, name)
    if (!existsSync(path)) {
      result.push({ path: name, content: `# 文件缺失：${name}` })
      continue
    }
    result.push({ path: name, content: readFileSync(path, 'utf8') })
  }
  return result
}

export function readEntryCode(dataDir: string, id: string): string {
  const manifest = readManifest(dataDir, id)
  const path = safePath(pluginDir(dataDir, id), manifest.entry)
  if (!existsSync(path)) throw new RunnerError(`entry missing: ${manifest.entry}`, 404)
  return readFileSync(path, 'utf8')
}

export function listSceneTemplates(dataDir: string): SceneTemplate[] {
  const root = join(dataDir, 'scenes')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => name.toLowerCase().endsWith('.blend'))
    .sort()
    .map((name) => ({ name: name.slice(0, -6), file: name }))
}
