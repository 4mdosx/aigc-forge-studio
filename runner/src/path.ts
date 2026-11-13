import { RunnerError } from './errors.ts'

export function relativePath(input: string): string {
  let text = input
  if (text.includes('%')) {
    try {
      text = decodeURIComponent(text)
    } catch {
      throw new RunnerError('invalid path')
    }
  }
  if (text.includes('\\') || text.startsWith('/') || text.includes('\0')) {
    throw new RunnerError('invalid path')
  }
  const parts = text.split('/')
  if (
    parts.length === 0 ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new RunnerError('invalid path')
  }
  return parts.join('/')
}

export function splitRelative(input: string): {
  subfolder: string
  filename: string
} {
  const safe = relativePath(input)
  const parts = safe.split('/')
  const filename = parts[parts.length - 1] ?? ''
  return { filename, subfolder: parts.slice(0, -1).join('/') }
}

export function comfyFilePath(
  type: string,
  subfolder: string,
  filename: string,
): string {
  return subfolder ? `${type}/${subfolder}/${filename}` : `${type}/${filename}`
}

export function viewTarget(input: string): {
  type: string
  subfolder: string
  filename: string
} {
  const safe = relativePath(input)
  const parts = safe.split('/')
  const type = parts[0]
  if (type !== 'input' && type !== 'output' && type !== 'temp') {
    throw new RunnerError('invalid path')
  }
  if (parts.length < 2) throw new RunnerError('invalid path')
  const filename = parts[parts.length - 1] ?? ''
  return { type, filename, subfolder: parts.slice(1, -1).join('/') }
}
