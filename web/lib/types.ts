import type { CreativeIntent } from './intent'

export interface Workflow {
  id: string
  name: string
  comfyPath: string
  currentBranch: string
  works: string[]
}

export interface Work {
  id: string
  name: string
  semantic: { inputs: Record<string, { type: 'string' | 'seed' | 'image' }> }
  createdAt: string
  workflows: WorkWorkflow[]
}

export interface WorkVersion {
  version: string
  message: string | null
  createdAt: string
  main: boolean
  head: boolean
  hasAdapter: boolean
  borrowedFrom: string | null
  adapter: Adapter | null
  adapterStatus: { status: 'missing' | 'ready' | 'mismatch'; error?: string }
  suggestedAdapter: Adapter | null
}

export interface WorkWorkflow {
  id: string
  name: string
  comfyPath: string
  versions?: WorkVersion[]
}

export interface AdapterBinding {
  class_type: string
  name?: string
  input?: string
  upload?: boolean
}

export interface Adapter {
  inputs: Record<string, AdapterBinding>
  outputs: Record<string, AdapterBinding>
}

export interface Revision {
  id: string
  version: string
  message: string | null
  createdAt: string
  head: boolean
  main?: boolean
  parents?: string[]
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export interface PromptTemplate {
  id: string
  chatType: string
  name: string
  system: string
  initialResult: CreativeIntent
}

export interface Chat {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: ChatMessage[]
}

export interface Task {
  id: string
  task: string
  workId: string | null
  workName: string | null
  workflowId: string | null
  workflowName: string | null
  comfyPath: string | null
  version: string | null
  headRevisionId: string | null
  parentTaskId: string | null
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
  promptId: string | null
  comfyBaseURL: string | null
  error: string | null
  outputPath: string | null
  process: Array<{ path: string; name: string; id: string }> | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export const terminal = new Set(['completed', 'failed', 'timeout', 'cancelled'])
