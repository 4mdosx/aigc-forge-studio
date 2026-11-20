// 采集握手只活在这个进程的内存里，重启即清空。
// Web 只有停在采集页并报 ready 才接任务；插件把链接送进来，再推给最近就绪的那个采集页。
// 在线状态推给两边，任务进度只从采集页推回插件。

export type LiveRole = 'web' | 'extension'

export type LiveSnapshot = {
  webReady: boolean
  webs: number
  extensions: number
}

export type LiveStatusState =
  | 'accepted'
  | 'rejected'
  | 'queued'
  | 'active'
  | 'done'
  | 'duplicate'
  | 'failed'

const WEB_STATUS = new Set<LiveStatusState>([
  'queued',
  'active',
  'done',
  'duplicate',
  'failed',
])

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/

export type LiveSocket = {
  send: (text: string) => void
}

type Peer = {
  id: string
  role: LiveRole | null
  ready: boolean
  readyAt: number
  socket: LiveSocket
}

export class CaptureLive {
  private readonly peers = new Map<string, Peer>()
  private seq = 0
  private readySeq = 0

  attach(socket: LiveSocket): string {
    this.seq += 1
    const id = `p${this.seq}`
    this.peers.set(id, {
      id,
      role: null,
      ready: false,
      readyAt: 0,
      socket,
    })
    return id
  }

  detach(id: string): void {
    const peer = this.peers.get(id)
    if (!peer) return
    this.peers.delete(id)
    if (peer.role) this.emitState()
  }

  snapshot(): LiveSnapshot {
    let webs = 0
    let extensions = 0
    let webReady = false
    for (const peer of this.peers.values()) {
      if (peer.role === 'web') {
        webs += 1
        if (peer.ready) webReady = true
      } else if (peer.role === 'extension') {
        extensions += 1
      }
    }
    return { webReady, webs, extensions }
  }

  receive(id: string, raw: string): void {
    const peer = this.peers.get(id)
    if (!peer) return
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      this.fail(peer, '消息不是 JSON')
      return
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      this.fail(peer, '消息必须是 JSON 对象')
      return
    }
    const message = body as Record<string, unknown>
    const type = message.type
    if (type === 'hello') {
      this.onHello(peer, message.role)
      return
    }
    if (!peer.role) {
      this.fail(peer, '先发送 hello')
      return
    }
    if (type === 'ready') {
      this.onReady(peer, message.ready)
      return
    }
    if (type === 'capture') {
      this.onCapture(peer, message)
      return
    }
    if (type === 'status') {
      this.onStatus(peer, message)
      return
    }
    this.fail(peer, '未知消息')
  }

  private onHello(peer: Peer, role: unknown): void {
    if (peer.role) {
      this.fail(peer, '已经握过手')
      return
    }
    if (role !== 'web' && role !== 'extension') {
      this.fail(peer, 'role 必须是 web 或 extension')
      return
    }
    peer.role = role
    this.emitState()
  }

  private onReady(peer: Peer, ready: unknown): void {
    if (peer.role !== 'web') {
      this.fail(peer, '只有采集页可以就绪')
      return
    }
    if (typeof ready !== 'boolean') {
      this.fail(peer, 'ready 必须是布尔值')
      return
    }
    if (peer.ready === ready) return
    peer.ready = ready
    this.readySeq += 1
    peer.readyAt = ready ? this.readySeq : 0
    this.emitState()
  }

  private onCapture(peer: Peer, message: Record<string, unknown>): void {
    if (peer.role !== 'extension') {
      this.fail(peer, '只有插件可以发起采集')
      return
    }
    const id = captureIdOf(message.id)
    if (!id) {
      this.fail(peer, '采集 id 无效')
      return
    }
    const url = httpUrlOf(message.url)
    if (!url) {
      this.reject(peer, id, 'url 必须是 http(s) 链接')
      return
    }
    let mediaUrl: string | undefined
    if (message.mediaUrl !== undefined) {
      const media = httpUrlOf(message.mediaUrl)
      if (!media) {
        this.reject(peer, id, 'mediaUrl 必须是 http(s) 链接')
        return
      }
      mediaUrl = media
    }
    const target = this.readyWeb()
    if (!target) {
      this.reject(peer, id, '采集页未打开')
      return
    }
    this.push(target, {
      type: 'capture',
      id,
      url,
      ...(mediaUrl ? { mediaUrl } : {}),
    })
    this.push(peer, {
      type: 'status',
      id,
      state: 'accepted',
      message: '已交给采集页',
    })
  }

  private onStatus(peer: Peer, message: Record<string, unknown>): void {
    if (peer.role !== 'web') {
      this.fail(peer, '只有采集页可以回报进度')
      return
    }
    if (!peer.ready) {
      this.fail(peer, '采集页未就绪')
      return
    }
    const id = captureIdOf(message.id)
    if (!id) {
      this.fail(peer, '采集 id 无效')
      return
    }
    const state = message.state
    if (
      typeof state !== 'string' ||
      !WEB_STATUS.has(state as LiveStatusState)
    ) {
      this.fail(peer, '状态无效')
      return
    }
    const status: {
      type: 'status'
      id: string
      state: LiveStatusState
      message?: string
    } = { type: 'status', id, state: state as LiveStatusState }
    if (typeof message.message === 'string' && message.message !== '') {
      status.message = message.message.slice(0, 500)
    }
    const text = JSON.stringify(status)
    for (const other of [...this.peers.values()]) {
      if (other.role !== 'extension') continue
      this.pushText(other, text)
    }
  }

  private reject(peer: Peer, id: string, message: string): void {
    this.push(peer, { type: 'status', id, state: 'rejected', message })
  }

  private readyWeb(): Peer | null {
    let best: Peer | null = null
    for (const peer of this.peers.values()) {
      if (peer.role !== 'web' || !peer.ready) continue
      if (!best || peer.readyAt >= best.readyAt) best = peer
    }
    return best
  }

  private emitState(): void {
    const text = JSON.stringify({ type: 'state', ...this.snapshot() })
    for (const peer of [...this.peers.values()]) {
      if (!peer.role) continue
      this.pushText(peer, text)
    }
  }

  private fail(peer: Peer, message: string): void {
    this.push(peer, { type: 'error', message })
  }

  private push(peer: Peer, body: unknown): void {
    this.pushText(peer, JSON.stringify(body))
  }

  private pushText(peer: Peer, text: string): void {
    try {
      peer.socket.send(text)
    } catch {
      // 发送失败留到下一拍再摘掉，避免广播状态时重入
      queueMicrotask(() => this.detach(peer.id))
    }
  }
}

function captureIdOf(value: unknown): string | null {
  if (typeof value !== 'string' || !ID_RE.test(value)) return null
  return value
}

function httpUrlOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '' || text.length > 4000) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return text
}
