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

const RUNNER = 'http://127.0.0.1:8787'

const select = document.getElementById('folder')
const statusEl = document.getElementById('status')
const grab = document.getElementById('grab')
const refresh = document.getElementById('refresh')

function setStatus(text, kind) {
  statusEl.textContent = text
  statusEl.className = kind ?? ''
}

async function loadFolders() {
  try {
    const res = await fetch(`${RUNNER}/capture/folders`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    const current = select.value
    select.innerHTML = ''
    if (body.folders.length === 0) {
      const option = document.createElement('option')
      option.value = ''
      option.textContent = '（先在 web /capture 新建文件夹）'
      select.appendChild(option)
      return
    }
    for (const folder of body.folders) {
      const option = document.createElement('option')
      option.value = folder.name
      option.textContent = `${folder.name}（${folder.done}）`
      select.appendChild(option)
    }
    if (current && body.folders.some((f) => f.name === current)) {
      select.value = current
    }
    setStatus('就绪')
  } catch (err) {
    setStatus(`runner 不可达（:${err.message}）`, 'error')
  }
}

grab.addEventListener('click', async () => {
  const folder = select.value
  if (!folder) {
    setStatus('没有可用文件夹，先去 web /capture 建一个', 'error')
    return
  }
  grab.disabled = true
  try {
    setStatus('读取页面…')
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPin,
    })
    const { url, imageUrl } = result.result
    setStatus(imageUrl ? '已锁定主图，上传中…' : '没找到主图锚点，交给 runner 解析…')
    const res = await fetch(`${RUNNER}/capture/pins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, folder, ...(imageUrl ? { mediaUrl: imageUrl } : {}) }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error || res.statusText)
    setStatus(
      body.duplicate ? '重复图片，已跳过' : `已采集 ${body.id}，预处理进行中（去 web /capture 看）`,
      body.duplicate ? '' : 'ok',
    )
  } catch (err) {
    setStatus(`失败：${err.message}`, 'error')
  } finally {
    grab.disabled = false
  }
})

refresh.addEventListener('click', () => void loadFolders())
void loadFolders()
