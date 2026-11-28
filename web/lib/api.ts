export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/runner/${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { 'content-type': 'application/json' }),
      ...init?.headers,
    },
  })
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) {
    if (!res.ok) throw new ApiError(res.statusText || 'request failed', res.status)
    return undefined as T
  }
  const body = (await res.json()) as { error?: string }
  if (!res.ok) throw new ApiError(body.error || 'request failed', res.status)
  return body as T
}

/** runner 路由路径（output/image/<id>、tasks/<id>/files/…、capture/file/…） */
export function fileHref(path: string): string {
  return `/api/runner/${path.replace(/^\/+/, '')}`
}

/**
 * 磁盘相对路径（output/… 、input/…）走 /files/* 静态端点。
 * 生成产物只存在于 outputPath 字段里，直接拼 /api/runner/output/… 会 404。
 */
export function storedFileHref(path: string): string {
  return fileHref(`files/${path.replace(/^\/+/, '')}`)
}
