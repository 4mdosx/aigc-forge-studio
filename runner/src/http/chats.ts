import type { Hono } from 'hono'

import { chatJson, continueChat, listChats } from '../chat/records.ts'
import { gatewayHint, type ChatClient } from '../chat/client.ts'
import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'
import { jsonObject, stringField } from './request.ts'

export function mountChats(app: Hono, runner: Runner): void {
  app.get('/chats', (c) =>
    c.json({
      chats: listChats(runner.db),
      models: runner.chat?.models ?? [],
      visionModel: runner.chat?.visionModel ?? '',
    }),
  )

  app.get('/chats/:id', (c) => c.json(chatJson(runner.db, c.req.param('id'))))

  app.post('/chats', async (c) => {
    const body = await jsonObject(c.req)
    const client = requireChat(runner)
    const chat = await continueChat(
      runner.db,
      undefined,
      {
        content: stringField(body, 'content'),
        images: submittedImages(body),
        model: chosenModel(body, client),
        system: submittedSystem(body),
      },
      client,
      runner.now(),
    )
    return c.json(chat, 201)
  })

  app.post('/chats/:id/messages', async (c) => {
    const body = await jsonObject(c.req)
    const client = requireChat(runner)
    const chat = await continueChat(
      runner.db,
      c.req.param('id'),
      {
        content: stringField(body, 'content'),
        images: submittedImages(body),
        model: chosenModel(body, client),
        system: submittedSystem(body),
      },
      client,
      runner.now(),
    )
    return c.json(chat)
  })
}

function submittedImages(body: Record<string, unknown>): string[] | undefined {
  if (body.images === undefined) return undefined
  const images = body.images
  if (
    !Array.isArray(images) ||
    !images.every((item) => typeof item === 'string')
  ) {
    throw new RunnerError('images must be an array of strings')
  }
  return images
}

function submittedSystem(body: Record<string, unknown>): string {
  if (body.system === undefined) return ''
  const system = stringField(body, 'system').trim()
  if (system === '') throw new RunnerError('system is required')
  return system
}

function requireChat(runner: Runner): ChatClient {
  if (!runner.chat) throw new RunnerError(gatewayHint, 503)
  return runner.chat
}

function chosenModel(
  body: Record<string, unknown>,
  client: ChatClient,
): string {
  const model =
    body.model === undefined ? client.models[0] : stringField(body, 'model')
  if (!model || (!client.models.includes(model) && model !== client.visionModel)) {
    throw new RunnerError('model is not available')
  }
  return model
}
