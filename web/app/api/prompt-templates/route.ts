import { loadPromptTemplates } from '@/lib/load-prompt-templates'

export async function GET() {
  try {
    const templates = await loadPromptTemplates()
    return Response.json({ templates })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: message }, { status: 503 })
  }
}
