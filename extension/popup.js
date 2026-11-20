// 在 pin 页面上下文里跑：锚定主图的 image signature，只取同一张图的最大变体。
// 必须自包含（MV3 会序列化注入），不许引用外部变量。
// 锚点优先级：og:image → #pin-image-preload（SSR 预加载）。
// 没有 signature 锚点时才扫 DOM img，且只在 main 区域（避开相关推荐网格）。
function extractPin() {
  const pageUrl =
    document.querySelector('meta[property="og:url"]')?.content ??
    location.href.split(/[?#]/)[0]

  const anchorCandidates = [
    document.querySelector('meta[property="og:image"]')?.content,
    document.querySelector('meta[name="og:image"]')?.content,
    document.getElementById('pin-image-preload')?.href,
  ].filter((value) => typeof value === 'string' && value.includes('i.pinimg.com'))

  // signature = pinimg 路径尾段（aa/bb/<hash16+>），同一张图所有尺寸变体共享
  const sigOf = (url) => {
    const hit = /i\.pinimg\.com\/[a-z0-9_]+\/([0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{16,})\./i.exec(url)
    return hit ? hit[1] : null
  }

  let sig = null
  for (const anchor of anchorCandidates) {
    sig = sigOf(anchor)
    if (sig) break
  }

  let best = null
  let bestScore = -1
  if (sig) {
    // 在页面内联数据（script JSON / preload link / meta）里找同 signature 的最大尺寸段
    const esc = sig.replace(/\//g, '\\/')
    const re = new RegExp(`i\\.pinimg\\.com\\/(originals|\\d+x\\d*)\\/${esc}`, 'gi')
    const hay = []
    for (const node of document.querySelectorAll('script, link[rel="preload"], meta')) {
      const text = node.tagName === 'SCRIPT' ? node.textContent : node.href || node.content
      if (text) hay.push(text)
    }
    let match
    while ((match = re.exec(hay.join('\n'))) !== null) {
      const segment = match[1].toLowerCase()
      const score = segment === 'originals' ? 1e9 : parseInt(segment, 10)
      if (score > bestScore) {
        bestScore = score
        best = match[0]
      }
    }
    if (!best && anchorCandidates.length > 0) best = anchorCandidates[0]
  } else {
    // 无锚点：只在 main 区域找（相关推荐通常在 main 外），取最大尺寸段
    const root = document.querySelector('main') ?? document.body
    for (const img of root.querySelectorAll('img[src*="i.pinimg.com"]')) {
      const src = img.currentSrc || img.src
      const hit = /\/(\d+)x|\/originals\//i.exec(src)
      const score = src.includes('/originals/') ? 1e8 : hit ? parseInt(hit[1], 10) : 0
      if (score > bestScore) {
        bestScore = score
        best = src
      }
    }
  }

  return { url: pageUrl, imageUrl: best }
}

const link = document.getElementById('link')
const statusEl = document.getElementById('status')
const grab = document.getElementById('grab')

function setStatus(text, kind) {
  statusEl.textContent = text
  statusEl.className = kind ?? ''
}

function applyState(state) {
  const ready = state?.connected === true && state?.webReady === true
  link.dataset.ready = ready ? '1' : '0'
  grab.disabled = !ready
  if (!state?.connected) link.textContent = 'runner 未连接'
  else if (!state.webReady) link.textContent = '采集页未打开'
  else link.textContent = '采集页已就绪'
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'live-state') applyState(message)
  if (message?.type === 'live-status') {
    const failed = message.state === 'rejected' || message.state === 'failed'
    const ok = message.state === 'accepted' || message.state === 'done'
    setStatus(message.message || message.state || '', failed ? 'error' : ok ? 'ok' : '')
  }
})

chrome.runtime.sendMessage({ type: 'live-snapshot' }, (state) => {
  if (chrome.runtime.lastError || !state) return
  applyState(state)
})

grab.addEventListener('click', async () => {
  grab.disabled = true
  try {
    setStatus('读取页面…')
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) throw new Error('没有当前标签页')
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPin,
    })
    const extracted = result?.result ?? {}
    const url = typeof extracted.url === 'string' && extracted.url.startsWith('http')
      ? extracted.url
      : tab.url
    if (!url || !url.startsWith('http')) throw new Error('这个页面没有可采集的链接')
    const mediaUrl = typeof extracted.imageUrl === 'string' ? extracted.imageUrl : ''
    setStatus('交给采集页…')
    const response = await chrome.runtime.sendMessage({
      type: 'capture-url',
      url,
      ...(mediaUrl ? { mediaUrl } : {}),
    })
    if (!response?.ok) throw new Error(response?.error || '采集页没有接住')
    setStatus(response.message || '已交给采集页', 'ok')
  } catch (err) {
    setStatus(`失败：${err.message}`, 'error')
  } finally {
    grab.disabled = link.dataset.ready !== '1'
  }
})
