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

export function fileHref(path: string): string {
  return `/api/runner/${path}`
}
