import type { Hono } from 'hono'

import { RunnerError } from '../errors.ts'
import type { Runner } from '../task/queue.ts'

// 训练页的显存面板数据源。两块来源拼一起：
//   gpu   —— 训练机 nvidia-smi（真整卡数字 + 逐进程，能看清谁在吃显存）
//   comfy —— ComfyUI /system_stats（RAM + ComfyUI 自己 torch 占的显存）
// 任一不可用都不报错，对应字段给 null + 一段 error 文本，面板照常渲染另一半。

interface TrainerGpuBody {
  gpus?: unknown
  processes?: unknown
  checkedAt?: string
}

export function mountSystem(app: Hono, runner: Runner): void {
  app.get('/system/gpu', async (c) => {
    const [gpu, comfy] = await Promise.all([
      readTrainerGpu(runner),
      readComfyStats(runner),
    ])
    return c.json({
      checkedAt: new Date().toISOString(),
      gpu: gpu.data,
      gpuError: gpu.error,
      comfy: comfy.data,
      comfyError: comfy.error,
    })
  })

  // 手动清 ComfyUI 显存：交还 dynamic VRAM 池后再读一次水位
  app.post('/system/comfy/free', async (c) => {
    const client = runner.clients[0]
    if (!client) throw new RunnerError('no ComfyUI client configured', 503)
    let before = null
    try {
      before = await client.systemStats()
    } catch {
      // 释放前的读数拿不到不影响主操作
    }
    await client.freeMemory()
    // /free 返回时模型才刚开始卸载，给 ComfyUI 一点时间真正还显存
    await new Promise((resolve) => setTimeout(resolve, 600))
    const after = await client.systemStats()
    return c.json({ before, after })
  })
}

async function readTrainerGpu(
  runner: Runner,
): Promise<{ data: TrainerGpuBody | null; error: string | null }> {
  if (!runner.trainerBaseURL) return { data: null, error: 'trainer not configured' }
  try {
    const res = await fetch(`${runner.trainerBaseURL}/gpu`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      const body = await res.text()
      // 404 基本等于「训练机上的 trainer 进程还是旧代码」：路由已提交，但没重启
      if (res.status === 404) {
        return {
          data: null,
          error:
            'trainer /gpu: HTTP 404（训练机 trainer 是旧版本，需 git pull + infra\\trainer_service.ps1 restart）',
        }
      }
      return { data: null, error: `trainer /gpu: HTTP ${res.status} ${body}` }
    }
    return { data: (await res.json()) as TrainerGpuBody, error: null }
  } catch (err) {
    return { data: null, error: messageOf(err) }
  }
}

async function readComfyStats(
  runner: Runner,
): Promise<{ data: unknown; error: string | null }> {
  const client = runner.clients[0]
  if (!client) return { data: null, error: 'no ComfyUI client configured' }
  try {
    return { data: await client.systemStats(), error: null }
  } catch (err) {
    return { data: null, error: messageOf(err) }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
