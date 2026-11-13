import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { transaction } from '../db.ts'
import { RunnerError } from '../errors.ts'
import type { ChatClient } from './client.ts'

interface ChatRow {
  id: string
  title: string
  created_at: string
  updated_at: string
}

interface ChatMessageRow {
  id: string
  chat_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export async function continueChat(
  db: DatabaseSync,
  chatId: string | undefined,
  content: string,
  model: string,
  client: ChatClient,
  now: Date,
): Promise<Record<string, unknown>> {
  const text = content.trim()
  if (text === '') throw new RunnerError('content is required')
  const existing = chatId === undefined ? undefined : chatById(db, chatId)
  const history = existing ? messagesOf(db, existing.id) : []
  const reply = await client.complete(model, [
    ...history.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    { role: 'user', content: text },
  ])
  const stamp = now.toISOString()
  const id = existing?.id ?? randomUUID()
  transaction(db, () => {
    if (!existing) {
      db.prepare(
        `INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      ).run(id, titleOf(text), stamp, stamp)
    } else {
      db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(stamp, id)
    }
    const insert = db.prepare(
      `INSERT INTO chat_messages (id, chat_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    insert.run(randomUUID(), id, 'user', text, stamp)
    insert.run(randomUUID(), id, 'assistant', reply, stamp)
  })
  return chatJson(db, id)
}

export function listChats(db: DatabaseSync): Array<Record<string, unknown>> {
  const rows = db
    .prepare('SELECT * FROM chats ORDER BY updated_at DESC, rowid DESC')
    .all() as unknown as ChatRow[]
  return rows.map(summary)
}

export function chatJson(
  db: DatabaseSync,
  id: string,
): Record<string, unknown> {
  const chat = chatById(db, id)
  return {
    ...summary(chat),
    messages: messagesOf(db, id).map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.created_at,
    })),
  }
}

function chatById(db: DatabaseSync, id: string): ChatRow {
  const row = db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as
    ChatRow | undefined
  if (!row) throw new RunnerError(`chat ${id} not found`, 404)
  return row
}

function messagesOf(db: DatabaseSync, chatId: string): ChatMessageRow[] {
  return db
    .prepare(
      `SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at, rowid`,
    )
    .all(chatId) as unknown as ChatMessageRow[]
}

function summary(chat: ChatRow): Record<string, unknown> {
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.created_at,
    updatedAt: chat.updated_at,
  }
}

function titleOf(content: string): string {
  const line = content.trim().replace(/\s+/g, ' ')
  if (line.length <= 48) return line
  return `${line.slice(0, 48)}…`
}
