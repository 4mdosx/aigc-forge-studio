import OpenAI from 'openai'

import { RunnerError } from '../errors.ts'
import type { GatewayConfig } from './env.ts'

const promptSystem = `你帮用户写出可以直接贴进 ComfyUI 文生图工作流的提示词。
用用户的语言交谈。缺信息时只追问一件事：主体、风格、构图或光线。
可以定稿时，先用一句话说明，再单独给出一段英文提示词。
不要讲模型原理，也不要写和这张图无关的内容。`

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatClient {
  models: string[]
  complete(model: string, turns: ChatTurn[]): Promise<string>
}

export const gatewayHint =
  'copy env.example.ts to env.ts and set AI_GATEWAY_KEY, AI_GATEWAY_URL, and AI_GATEWAY_MODEL'

export function gatewayChat(config: GatewayConfig): ChatClient {
  const llm = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: 60_000,
    maxRetries: 1,
  })
  return {
    models: config.models,
    async complete(model, turns) {
      if (!config.models.includes(model)) {
        throw new RunnerError('model is not available')
      }
      let result: OpenAI.Chat.Completions.ChatCompletion
      try {
        result = await llm.chat.completions.create({
          model,
          messages: [{ role: 'system', content: promptSystem }, ...turns],
        })
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        throw new RunnerError(detail, 502)
      }
      const content = result.choices[0]?.message?.content
      if (typeof content !== 'string' || content === '') {
        throw new RunnerError('LLM did not return text', 502)
      }
      return content
    },
  }
}
