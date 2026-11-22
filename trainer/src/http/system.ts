import type { Hono } from 'hono'

import type { Trainer } from '../download/manager.ts'
import { TrainerError } from '../errors.ts'
import { readDisk } from '../system/disk.ts'
import { readGpu } from '../system/gpu.ts'

// GET /gpu：训练机上的 nvidia-smi 快照（整卡 + 逐进程）。
// 训练页要靠它区分「显存被 ComfyUI 占着」和「训练自己吃满」。
// GET /disk：各 root 的剩余空间——清 ckpt / latent cache 之前先看这个。
export function mountSystem(app: Hono, trainer: Trainer): void {
  app.get('/gpu', async (c) => {
    try {
      const report = await readGpu()
      return c.json({ checkedAt: new Date().toISOString(), ...report })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new TrainerError(`nvidia-smi failed: ${message.slice(0, 300)}`, 502)
    }
  })

  app.get('/disk', async (c) => {
    const report = await readDisk(trainer.roots)
    return c.json({ checkedAt: new Date().toISOString(), ...report })
  })
}
