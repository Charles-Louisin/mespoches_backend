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

  if (
    /unknownhost|unable to resolve host|failed to connect|econnrefused|enotfound|fetch failed|network/i.test(
      lower
    )
  ) {
    return 'Pas de connexion. Vérifiez Internet et réessayez.'
  }
  if (/java\.|exception:|at com\.|stacktrace|statuscode/i.test(lower)) {
    return 'Analyse impossible. Réessayez.'
  }
  if (lower.includes('openai_api_key') || lower.includes('openrouter_api_key') || lower.includes('api key')) {
    return 'Clé IA non configurée sur le serveur.'
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('quota') || lower.includes('insufficient_quota')) {
    return 'Quota IA atteint. Réessayez dans 1 à 2 minutes.'
  }
  if (
    /model.*(not found|introuvable|does not exist)|no endpoints found|tous les modèles|tous les modeles/i.test(
      lower
    )
  ) {
    return 'Service d’analyse momentanément indisponible. Réessayez plus tard.'
  }
  if (
    /aucun mot reconnu|audio vide|rien de lisible dans l[’']audio/i.test(lower) &&
    !/transaction|note vocale/i.test(lower)
  ) {
    return 'Rien de lisible dans l’audio. Parlez plus clairement et réessayez.'
  }
  if (/rien de lisible sur la photo|image vide|ticket illisible|analyse.*image/i.test(lower)) {
    return 'Rien de lisible sur la photo. Rapprochez le ticket et réessayez.'
  }
  if (lower.includes('aucune transaction') || lower.includes('détecter une transaction')) {
    return 'Aucune transaction détectée. Précisez le montant et réessayez.'
  }
  if (lower.includes('illisible') || lower.includes('json')) {
    return "L'IA n'a pas pu extraire les informations. Réessayez avec une image plus nette."
  }
  if (msg.length > 140) return 'Analyse IA impossible. Réessayez.'
  return msg
}
