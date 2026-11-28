const runnerURL = (process.env.RUNNER_URL ?? 'http://127.0.0.1:8787').replace(
  /\/+$/,
  '',
)

async function forward(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params
  const incoming = new URL(request.url)
  const target = `${runnerURL}/${path.map(encodeURIComponent).join('/')}${incoming.search}`
  const headers = new Headers()
  const contentType = request.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body:
        request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : await request.arrayBuffer(),
      cache: 'no-store',
    })
    const responseHeaders = new Headers()
    const type = upstream.headers.get('content-type')
    if (type) responseHeaders.set('content-type', type)
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json(
      { error: `runner unavailable: ${message}` },
      { status: 502 },
    )
  }
}

export const GET = forward
export const POST = forward
export const PUT = forward
export const PATCH = forward
export const DELETE = forward
