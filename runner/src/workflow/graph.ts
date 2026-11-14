export interface WorkflowNode {
  class_type: string
  inputs: Record<string, unknown>
  _meta?: { title?: string }
}

export type Prompt = Record<string, WorkflowNode>
