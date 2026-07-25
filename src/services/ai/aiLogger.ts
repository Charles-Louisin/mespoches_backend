import type { AiCallLog } from './types'

/** Journalisation structurée des appels IA. */
export function logAiCall(entry: AiCallLog): void {
  const payload = {
    ts: new Date().toISOString(),
    ...entry,
  }
  if (entry.success) {
    console.info('[AI]', JSON.stringify(payload))
  } else {
    console.warn('[AI]', JSON.stringify(payload))
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function extractJsonObject(text: string): string | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : trimmed
  const match = candidate.match(/\{[\s\S]*\}/)
  return match ? match[0] : null
}

export function isRetryableOpenRouterError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  return (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('quota') ||
    lower.includes('503') ||
    lower.includes('502') ||
    lower.includes('504') ||
    lower.includes('timeout') ||
    lower.includes('overloaded') ||
    lower.includes('not found') ||
    lower.includes('no endpoints') ||
    lower.includes('unavailable') ||
    lower.includes('réponse vide') ||
    lower.includes('reponse vide') ||
    lower.includes('illisible') ||
    lower.includes('json attendu') ||
    lower.includes('json invalide') ||
    lower.includes('json') ||
    lower.includes('content_filter') ||
    lower.includes('refused') ||
    lower.includes('provider returned error') ||
    // "model … not found" / "No endpoints found for model"
    /no endpoints|model.*(not found|unavailable)/i.test(msg)
  )
}

export function formatAiError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()

  if (lower.includes('openrouter_api_key') || lower.includes('api key')) {
    return 'Clé OpenRouter non configurée sur le serveur.'
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('quota')) {
    return 'Quota IA atteint. Réessayez dans 1 à 2 minutes.'
  }
  if (lower.includes('tous les modèles') || lower.includes('tous les modeles')) {
    return 'Service IA temporairement indisponible. Réessayez plus tard.'
  }
  if (lower.includes('aucune transaction')) {
    return 'Aucune transaction détectée.'
  }
  if (lower.includes('illisible') || lower.includes('json')) {
    return "L'IA n'a pas pu extraire les informations. Réessayez avec une image plus nette."
  }
  return msg.length > 180 ? 'Analyse IA impossible. Réessayez.' : msg
}
