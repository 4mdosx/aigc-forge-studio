// MV3 background service worker：图片右键采集。
// 菜单唯一入口 = rebuildMenus()（先 removeAll 再 create，杜绝 duplicate id）。
// 插件不自己下载。它和采集页都连 runner 的 /capture/live，握手状态在 runner 内存里。
// 采集页开着才算 ready。右键或 popup 把 url 交给 runner，由采集页执行下载。

const LIVE = 'ws://127.0.0.1:8787/capture/live'
const ICON_URL = chrome.runtime.getURL('icon128.png')

let socket = null
let webReady = false
let connectAttempt = 0
let reconnectTimer = null
const openWaiters = []
const pending = new Map()

function connected() {
  return socket !== null && socket.readyState === WebSocket.OPEN
}

function publish(body) {
  try {
    const result = chrome.runtime.sendMessage(body)
    if (result && typeof result.catch === 'function') result.catch(() => {})
  } catch {
    // popup 没开时没有接收方
  }
}

function publishState() {
  publish({ type: 'live-state', webReady, connected: connected() })
}

function failOpen(error) {
  const waiters = openWaiters.splice(0)
  for (const waiter of waiters) waiter.reject(error)
}

function connect() {
  if (
    socket &&
    (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
  ) {
    return
  }
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  const ws = new WebSocket(LIVE)
  socket = ws
  ws.onopen = () => {
    connectAttempt = 0
    ws.send(JSON.stringify({ type: 'hello', role: 'extension' }))
    const waiters = openWaiters.splice(0)
    for (const waiter of waiters) waiter.resolve()
  }
  ws.onmessage = (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (!message || typeof message !== 'object') return
    if (message.type === 'state') {
      webReady = message.webReady === true
      publishState()
      return
    }
    if (message.type !== 'status') return
    const waiter = pending.get(message.id)
    if (waiter && (message.state === 'accepted' || message.state === 'rejected')) {
      pending.delete(message.id)
      waiter(message)
    }
    notifyStatus(message)
    publish({
      type: 'live-status',
      id: message.id,
      state: message.state,
      message: message.message,
    })
  }
  ws.onclose = () => {
    if (socket !== ws) return
    socket = null
    webReady = false
    publishState()
    failOpen(new Error('runner 未连接'))
    const delay = Math.min(5000, 300 * 2 ** connectAttempt)
    connectAttempt += 1
    reconnectTimer = setTimeout(connect, delay)
  }
  ws.onerror = () => {
    ws.close()
  }
}

function whenOpen() {
  connect()
  if (connected()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      finish(() => reject(new Error('runner 未连接')))
    }, 4000)
    const waiter = {
      resolve() {
        finish(resolve)
      },
      reject(error) {
        finish(() => reject(error))
      },
    }
    function finish(done) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const index = openWaiters.indexOf(waiter)
      if (index >= 0) openWaiters.splice(index, 1)
      done()
    }
    openWaiters.push(waiter)
  })
}

function makeId() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function requestCapture({ url, mediaUrl }) {
  return new Promise((resolve) => {
    const id = makeId()
    const timer = setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      resolve({ ok: false, error: 'runner 没有回应', notified: false })
    }, 8000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolve({
        ok: message.state !== 'rejected',
        error: message.message || '采集页未打开',
        message: message.message || '已交给采集页',
        notified: true,
      })
    })
    const body = { type: 'capture', id, url }
    if (mediaUrl) body.mediaUrl = mediaUrl
    whenOpen()
      .then(() => {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          throw new Error('runner 未连接')
        }
        socket.send(JSON.stringify(body))
      })
      .catch((err) => {
        clearTimeout(timer)
        pending.delete(id)
        resolve({ ok: false, error: String(err.message || err), notified: false })
      })
  })
}

function notifyStatus(message) {
  if (message.state === 'queued' || message.state === 'active') return
  const failed = message.state === 'rejected' || message.state === 'failed'
  const title = failed
    ? '采集失败'
    : message.state === 'duplicate'
      ? '重复图片，已跳过'
      : message.state === 'accepted'
        ? '已交给采集页'
        : '已采集'
  const text =
    typeof message.message === 'string' && message.message !== ''
      ? message.message
      : title
  showNotice(typeof message.id === 'string' ? message.id : '', title, text)
}

function showNotice(id, title, message) {
  const options = {
    type: 'basic',
    iconUrl: ICON_URL,
    title,
    message,
  }
  if (!id) {
    chrome.notifications.create(options)
    return
  }
  chrome.notifications.clear(id, () => {
    chrome.notifications.create(id, options)
  })
}

function rebuildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'capture',
      title: '采集到工作台',
      contexts: ['image'],
    })
  })
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'live-snapshot') {
    connect()
    sendResponse({ webReady, connected: connected() })
    return
  }
  if (message?.type === 'capture-url') {
    void requestCapture(message).then((result) => sendResponse(result))
    return true
  }
})

// 注入 pixiv 页面跑：从点击的缩略图找同一张画的 img-original 原图 URL。
// 自包含（MV3 序列化注入）。找不到返回 null，调用方退回缩略图。
async function pixivExtractOriginal(srcUrl) {
  const hit = /(\d+_p\d+)(?:_master1200|_square1200)?\.(jpg|jpeg|png|gif)/i.exec(srcUrl)
  if (!hit) return null // 动图/ugoira 等命名，交给 runner 原样处理
  if (srcUrl.includes('/img-original/')) return srcUrl
  const base = hit[1]

  // 作品 id：当前在作品页就直接用，否则找点击图片外层最近的 artworks 链接
  let artworkId = /\/artworks\/(\d+)/.exec(location.pathname)?.[1] ?? null
  if (!artworkId) {
    for (const img of document.querySelectorAll('img')) {
      const cur = (img.currentSrc || img.src || '').split(/[?#]/)[0]
      if (cur !== srcUrl.split(/[?#]/)[0]) continue
      const anchor = img.closest('a[href*="/artworks/"]')
      const matched = anchor ? /\/artworks\/(\d+)/.exec(anchor.href) : null
      if (matched) {
        artworkId = matched[1]
        break
      }
    }
  }
  if (!artworkId) return null

  // 同源 fetch 带登录态；作品页内嵌 JSON 里的原图 URL 是 \\/ 转义形态
  try {
    const res = await fetch(`https://www.pixiv.net/artworks/${artworkId}/`, {
      credentials: 'include',
    })
    if (!res.ok) return null
    const html = await res.text()
    const escaped = new RegExp(
      `https:\\\\/\\\\/i\\\\.pximg\\\\.net\\\\/img-original\\\\/[^"\\\\]+${base}\\.(jpg|png|gif|jpeg)`,
      'i',
    )
    const match =
      escaped.exec(html) ??
      new RegExp(`i\\.pximg\\.net\\/img-original\\/[^"']+${base}\\.(jpg|png|gif|jpeg)`, 'i').exec(
        html,
      )
    if (!match) return null
    let url = match[0].replace(/\\\//g, '/')
    if (!url.startsWith('https://')) url = `https://${url}`
    return url
  } catch {
    return null
  }
}

function isPixiv(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return /(^|\.)pixiv\.net$/.test(host) || /(^|\.)pximg\.net$/.test(host)
  } catch {
    return false
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'capture') return
  const src = info.srcUrl
  if (!src) return showNotice('', '采集失败', '右键目标没有图片地址')

  let mediaUrl = src
  if (tab?.id !== undefined && isPixiv(tab.url ?? '')) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: pixivExtractOriginal,
        args: [src],
      })
      const original = result?.result
      if (original) mediaUrl = original
    } catch {
      // 注入失败（无 activeTab 授权等）：退回缩略图 URL
    }
  }

  const pageUrl = tab?.url && tab.url.startsWith('http') ? tab.url : src
  const result = await requestCapture({
    url: pageUrl,
    ...(mediaUrl ? { mediaUrl } : {}),
  })
  if (!result.ok && !result.notified) {
    showNotice('', '采集失败', result.error || '采集失败')
  }
})

function arm() {
  chrome.alarms.create('capture-live', { periodInMinutes: 0.5 })
  connect()
  rebuildMenus()
}

chrome.runtime.onInstalled.addListener(arm)
chrome.runtime.onStartup.addListener(arm)
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'capture-live') connect()
})
arm()
