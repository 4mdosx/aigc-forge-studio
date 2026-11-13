import { RunnerError } from './errors.ts'

export async function completePrompt(
  baseURL: string,
  model: string,
  input: { prompt: string; system?: string },
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let res: Response
  try {
    res = await fetchImpl(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          ...(input.system ? [{ role: 'system', content: input.system }] : []),
          { role: 'user', content: input.prompt },
        ],
      }),
      signal,
    })
  } catch (err) {
    if (signal.aborted) throw new RunnerError('interrupted')
    const detail = err instanceof Error ? err.message : String(err)
    throw new RunnerError(`cannot reach ${baseURL}: ${detail}`)
  }
  if (!res.ok) throw new RunnerError(await res.text())
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>
  }
  const content = body.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content === '') {
    throw new RunnerError('LLM did not return text')
  }
  return content
}
