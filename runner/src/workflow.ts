import { RunnerError } from './errors.ts'

export interface WorkflowNode {
  class_type: string
  inputs: Record<string, unknown>
  _meta?: { title?: string }
}

export type Prompt = Record<string, WorkflowNode>

export function setInput(
  prompt: Prompt,
  nodeId: string,
  input: string,
  value: unknown,
): void {
  const node = prompt[nodeId]
  if (!node) throw new RunnerError(`workflow has no node ${nodeId}`)
  node.inputs[input] = value
}
