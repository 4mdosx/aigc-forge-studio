import OpenAI from 'openai'

import { RunnerError } from '../errors.ts'
import type { GatewayConfig } from './env.ts'

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatClient {
  models: string[]
  complete(model: string, turns: ChatTurn[], system: string): Promise<string>
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
    async complete(model, turns, system) {
      if (!config.models.includes(model)) {
        throw new RunnerError('model is not available')
      }
      const prompt = system.trim()
      let result: OpenAI.Chat.Completions.ChatCompletion
      try {
        result = await llm.chat.completions.create({
          model,
          messages: prompt
            ? [{ role: 'system', content: prompt }, ...turns]
            : turns,
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
