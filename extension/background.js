// MV3 background service worker：图片右键菜单采集。
// 菜单唯一入口 = rebuildMenus()（先 removeAll 再 create，杜绝 duplicate id）。
// SW 唤醒即重建；popup 采集成功后发 refresh-menus 消息唤醒 SW 顺带刷新菜单。
// folder 列表取自 runner；「采集到上次 folder」用 chrome.storage.local 记忆最近成功目标。
// pixiv 页面：登录态下把点击的缩略图升级到 /img-original/ 原图 URL 再交给 runner。

const RUNNER = 'http://127.0.0.1:8787'
const PARENT = 'aigc-capture-root'
const FALLBACK_FOLDER = 'common'

const ICON_URL = chrome.runtime.getURL('icon128.png')

async function loadFolders() {
  try {
    const res = await fetch(`${RUNNER}/capture/folders`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    return body.folders.map((f) => f.name)
  } catch {
    return []
  }
}

async function lastFolderOf() {
  try {
    const stored = await chrome.storage.local.get('lastFolder')
    const value = stored.lastFolder
    return typeof value === 'string' && value !== '' ? value : null
  } catch {
    return null
  }
}

async function rebuildMenus() {
  const folders = await loadFolders()
  const list = folders.length > 0 ? folders : [FALLBACK_FOLDER]
  const last = await lastFolderOf()
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: PARENT,
      title: 'AIGC 采集',
      contexts: ['image'],
    })
    if (last) {
      chrome.contextMenus.create({
        id: 'capture:last',
        parentId: PARENT,
        title: `采集到上次 folder（${last}）`,
        contexts: ['image'],
      })
    }
    for (const name of list) {
      chrome.contextMenus.create({
        id: `capture:${name}`,
        parentId: PARENT,
        title: `采集到 ${name}`,
        contexts: ['image'],
      })
    }
  })
}

// popup 采集成功后唤醒 SW 并刷新菜单（新建的 folder 立即可见）
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'refresh-menus') void rebuildMenus()
})

async function markLastFolder(folder) {
  try {
    await chrome.storage.local.set({ lastFolder: folder })
  } catch {
    // 记忆失败不影响采集
  }
}

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
  const raw = String(info.menuItemId)
  if (!raw.startsWith('capture:')) return
  const folder =
    raw === 'capture:last'
      ? await lastFolderOf()
      : raw.slice('capture:'.length)
  if (!folder) return notify('采集失败', '还没有「上次 folder」，先用具体 folder 采一张')
  const src = info.srcUrl
  if (!src) return notify('采集失败', '右键目标没有图片地址')

  let mediaUrl = src
  let upgraded = false
  if (tab?.id !== undefined && isPixiv(tab.url ?? '')) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: pixivExtractOriginal,
        args: [src],
      })
      const original = result?.result
      if (original) {
        mediaUrl = original
        upgraded = true
      }
    } catch {
      // 注入失败（无 activeTab 授权等）：退回缩略图 URL
    }
  }

  // 作品页右键时 source 用页面本身；网格页 source 就是当前页（没有更好的出处）
  const pageUrl = tab?.url && tab.url.startsWith('http') ? tab.url : undefined
  try {
    const res = await fetch(`${RUNNER}/capture/pins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        folder,
        mediaUrl,
        ...(pageUrl ? { url: pageUrl } : {}),
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || res.statusText)
    void markLastFolder(folder)
    if (data.duplicate) {
      notify('重复图片，已跳过', `folder ${folder} 里已有这张图`)
    } else {
      notify('已采集到 ' + folder, `${data.id}（${upgraded ? '原图' : '点击图'}，预处理进行中）`)
    }
  } catch (err) {
    notify('采集失败', String(err.message || err))
  }
})

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: ICON_URL,
    title,
    message,
  })
}

// SW 唤醒即重建菜单：先 fallback 秒出，runner 数据到了再刷一轮
void rebuildMenus()
