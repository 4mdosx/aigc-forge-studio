export interface Workflow {
  id: string
  name: string
  comfyPath: string
  currentBranch: string
}

export interface Revision {
  id: string
  version: number
  message: string | null
  createdAt: string
}

export interface Task {
  id: string
  executor: 'comfyui' | 'llm'
  task: string
  workflowName: string | null
  headRevisionId: string | null
  parentTaskId: string | null
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
  promptId: string | null
  comfyBaseURL: string | null
  error: string | null
  outputText: string | null
  outputPath: string | null
  process: Array<{ path: string; name: string; id: string }> | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export const terminal = new Set(['completed', 'failed', 'timeout', 'cancelled'])
