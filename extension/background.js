// MV3 background service worker：图片右键菜单采集。
// SW 每次唤醒都会跑顶层代码——菜单在这里重建（removeAll 防重复），folder 列表取自 runner。

const RUNNER = 'http://127.0.0.1:8787'
const PARENT = 'aigc-capture-root'
const FALLBACK_FOLDER = 'common'

// 通知图标（打包进扩展的小绿块）
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

function rebuildMenus(folders) {
  const list = folders.length > 0 ? folders : [FALLBACK_FOLDER]
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: PARENT,
      title: 'AIGC 采集',
      contexts: ['image'],
    })
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

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId)
  if (!id.startsWith('capture:')) return
  const folder = id.slice('capture:'.length)
  const src = info.srcUrl
  if (!src) return notify('采集失败', '右键目标没有图片地址')

  // pin 页右键时 source 用页面本身；网格页 source 就是当前页（没有更好的出处）
  const pageUrl =
    tab?.url && tab.url.startsWith('http') ? tab.url : undefined
  const body = {
    folder,
    mediaUrl: src,
    ...(pageUrl ? { url: pageUrl } : {}),
  }
  try {
    const res = await fetch(`${RUNNER}/capture/pins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || res.statusText)
    if (data.duplicate) {
      notify('重复图片，已跳过', `folder ${folder} 里已有这张图`)
    } else {
      notify('已采集到 ' + folder, `${data.id}（预处理进行中）`)
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

chrome.contextMenus.create({
  id: PARENT,
  title: 'AIGC 采集',
  contexts: ['image'],
})
loadFolders().then(rebuildMenus)
