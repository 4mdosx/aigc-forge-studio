export interface VariableSpec {
  type: 'number' | 'string' | 'boolean' | 'select'
  label?: string
  default?: unknown
  min?: number
  max?: number
  step?: number
  options?: string[]
}

export interface PluginSummary {
  id: string
  name: string
  description: string
  variables: Record<string, VariableSpec>
}

export interface SourceFile {
  path: string
  content: string
}

export interface PluginDetail {
  manifest: {
    id: string
    name: string
    description: string
    entry: string
    files: string[]
    variables: Record<string, VariableSpec>
  }
  sources: SourceFile[]
}

export interface SceneInfo {
  name: string
  active: boolean
  filepath: string
}

export interface ScenesPayload {
  active: string | null
  scenes: SceneInfo[]
  templates: Array<{ name: string; file: string }>
  filepath: string
}

export interface StatusPayload {
  connected: boolean
  scenes: SceneInfo[]
  activeScene: string | null
  filepath: string
  error?: string
}

export interface RunRecord {
  id: string
  pluginId: string
  scene: string | null
  variables: Record<string, unknown>
  status: 'running' | 'ok' | 'error'
  createdAt: string
  finishedAt?: string
  log?: string
  error?: string
  outputDir: string
}
