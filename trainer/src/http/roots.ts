import type { Hono } from 'hono'

import type { Trainer } from '../download/manager.ts'

// 根目录在 config.json 的 trainer.roots 里写死，这里只读
export function mountRoots(app: Hono, trainer: Trainer): void {
  app.get('/roots', (c) => c.json({ roots: trainer.roots }))
}
