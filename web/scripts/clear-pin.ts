import { clearStoredPin } from '../lib/auth-store.ts'

const removed = clearStoredPin()
if (removed) {
  console.log('PIN 已清除。下次进入页面需要重新设置。')
} else {
  console.log('当前没有设置 PIN。')
}
