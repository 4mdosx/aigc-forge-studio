import { TrainerError } from './errors.ts'

// 与 runner/src/path.ts 同一套约定：posix 风格相对路径，
// 拒绝反斜杠、绝对路径、空段、'.'、'..'、'\0'。
export function relativePath(input: string): string {
  let text = input
  if (text.includes('%')) {
    try {
      text = decodeURIComponent(text)
    } catch {
      throw new TrainerError('invalid path')
    }
  }
  if (
    text.includes('\\') ||
    text.startsWith('/') ||
    text.includes('\0') ||
    /^[a-zA-Z]:/.test(text) // Windows 盘符前缀（C:/x 在 posix 上长得像相对路径）
  ) {
    throw new TrainerError('invalid path')
  }
  const parts = text.split('/')
  if (
    parts.length === 0 ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new TrainerError('invalid path')
  }
  return parts.join('/')
}
