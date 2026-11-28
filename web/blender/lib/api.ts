export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export async function runnerApi<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`/api/runner/${path.replace(/^\/+/, '')}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
    cache: 'no-store',
  })
  const text = await res.text()
  let body: unknown = null
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `request failed (${res.status})`
    throw new ApiError(message, res.status)
  }
  return body as T
}
