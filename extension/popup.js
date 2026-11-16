// 在 pin 页面上下文里跑：抓 og:image 和 DOM 里最大的 pinimg 图。
// 必须自包含（MV3 会序列化注入），不许引用外部变量。
function extractPin() {
  const score = (url) => {
    if (url.includes('/originals/')) return 100000
    const hit = /\/(\d+)x/.exec(url)
    return hit ? parseInt(hit[1], 10) : 0
  }
  let best = document.querySelector('meta[property="og:image"]')?.content ?? null
  let bestScore = best ? score(best) : 0
  for (const img of document.querySelectorAll('img[src*="i.pinimg.com"]')) {
    const src = img.currentSrc || img.src
    const s = score(src)
    if (s > bestScore) {
      bestScore = s
      best = src
    }
  }
  for (const img of document.querySelectorAll('img[srcset*="i.pinimg.com"]')) {
    for (const part of (img.srcset || '').split(',')) {
      const url = part.trim().split(/\s+/)[0]
      const s = score(url)
      if (s > bestScore) {
        bestScore = s
        best = url
      }
    }
  }
  return { url: location.href.split(/[?#]/)[0], imageUrl: best }
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
    setStatus(imageUrl ? '已找到图片，上传中…' : '页面里没找到 pinimg 图，交给 runner 解析…')
    const res = await fetch(`${RUNNER}/capture/pins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, folder, ...(imageUrl ? { mediaUrl: imageUrl } : {}) }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error || res.statusText)
    setStatus(`已采集 ${body.id}，预处理进行中（去 web /capture 看）`, 'ok')
  } catch (err) {
    setStatus(`失败：${err.message}`, 'error')
  } finally {
    grab.disabled = false
  }
})

refresh.addEventListener('click', () => void loadFolders())
void loadFolders()
