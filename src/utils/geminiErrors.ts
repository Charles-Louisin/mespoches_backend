/** Messages d'erreur Gemini lisibles côté client (sans dump Google). */

export function isModelUnavailableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes('not found') ||
    lower.includes('not supported') ||
    lower.includes('404') ||
    lower.includes('is not found for api version')
  );
}

export function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return lower.includes('429') || lower.includes('quota') || lower.includes('rate limit');
}

export function parseRetryDelayMs(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/retry in ([\d.]+)s/i);
  if (match) {
    return Math.min(Math.ceil(parseFloat(match[1]) * 1000) + 200, 8000);
  }
  return 2500;
}

export function formatGeminiError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (isQuotaError(err)) {
    return 'Quota IA Gemini atteint. Réessayez dans 1 à 2 minutes, ou vérifiez votre forfait sur Google AI Studio.';
  }
  if (isModelUnavailableError(err)) {
    return 'Modèle IA temporairement indisponible. Réessayez plus tard.';
  }
  if (lower.includes('gemini_api_key') || lower.includes('api key')) {
    return 'Clé Gemini non configurée sur le serveur.';
  }
  if (lower.includes('aucune transaction détectée')) {
    return 'Aucune transaction détectée sur l\'image.';
  }
  if (lower.includes('réponse ia illisible')) {
    return 'L\'IA n\'a pas pu lire le reçu. Essayez une photo plus nette.';
  }

  return msg.length > 180 ? 'Analyse IA impossible. Réessayez.' : msg;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Modèles essayés — 1.5 flash en premier (quota free tier souvent disponible). */
export const GEMINI_MODELS = [
  'gemini-1.5-flash',
  'gemini-1.5-flash-latest',
  'gemini-2.0-flash',
] as const;
