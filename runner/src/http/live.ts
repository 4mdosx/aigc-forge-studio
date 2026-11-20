import { upgradeWebSocket } from '@hono/node-server'
import type { Hono } from 'hono'

import type { CaptureLive } from '../capture/live.ts'

// 采集页和插件都连这里。握手是否就绪只看内存里的 CaptureLive。
export function mountCaptureLive(app: Hono, live: CaptureLive): void {
  app.get(
    '/capture/live',
    upgradeWebSocket(() => {
      const slot = { id: '' }
      return {
        onOpen(_event, ws) {
          slot.id = live.attach({
            send(text) {
              ws.send(text)
            },
          })
        },
        onMessage(event) {
          if (typeof event.data !== 'string' || slot.id === '') return
          live.receive(slot.id, event.data)
        },
        onClose() {
          if (slot.id === '') return
          live.detach(slot.id)
        },
      }
    }),
  )
}
