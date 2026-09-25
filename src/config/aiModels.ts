/**
 * Configuration des modèles OpenRouter — payants uniquement.
 * Les IDs `:free` sont ignorés (quotas, souvent down, 0 crédit débité).
 */

export type AiModelConfig = {
  id: string
  label: string
  /** Vision = images ; text = notifications / SMS */
  modality: 'vision' | 'text' | 'both'
}

const PAID_VISION_DEFAULTS = [
  'google/gemini-2.5-flash',
  'openai/gpt-4o-mini',
  'google/gemini-2.0-flash-001',
] as const

const PAID_TEXT_DEFAULTS = [
  'openai/gpt-4o-mini',
  'google/gemini-2.5-flash',
  'google/gemini-2.0-flash-001',
] as const

export function isFreeOpenRouterModel(id: string): boolean {
  const n = id.trim().toLowerCase()
  return n.endsWith(':free') || n === 'openrouter/free' || n.includes('/free')
}

function paidModelId(raw: string | undefined, fallback: string): string {
  const id = (raw || '').trim()
  if (!id || isFreeOpenRouterModel(id)) return fallback
  return id
}

function buildPaidModels(
  envKeys: string[],
  defaults: readonly string[],
  modality: AiModelConfig['modality']
): AiModelConfig[] {
  const seen = new Set<string>()
  const out: AiModelConfig[] = []
  defaults.forEach((fallback, i) => {
    const id = paidModelId(process.env[envKeys[i]], fallback)
    if (seen.has(id)) return
    seen.add(id)
    out.push({ id, label: id, modality })
  })
  return out
}

/** Ordre de fallback Vision (scan ticket) — modèles payants. */
export const VISION_MODELS: AiModelConfig[] = buildPaidModels(
  [
    'OPENROUTER_VISION_MODEL_1',
    'OPENROUTER_VISION_MODEL_2',
    'OPENROUTER_VISION_MODEL_3',
  ],
  PAID_VISION_DEFAULTS,
  'both'
)

/** Ordre de fallback texte (SMS / notifications / voix). */
export const TEXT_MODELS: AiModelConfig[] = buildPaidModels(
  ['OPENROUTER_TEXT_MODEL_1', 'OPENROUTER_TEXT_MODEL_2', 'OPENROUTER_TEXT_MODEL_3'],
  PAID_TEXT_DEFAULTS,
  'text'
)

export const OPENROUTER_WHISPER_MODEL = (() => {
  const raw = process.env.OPENROUTER_WHISPER_MODEL?.trim()
  if (raw && !isFreeOpenRouterModel(raw)) return raw
  return 'openai/whisper-large-v3'
})()

/** Seuil en dessous duquel on signale une faible confiance à l'utilisateur. */
export const LOW_CONFIDENCE_THRESHOLD = 0.75

export const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'

export const OPENROUTER_SITE_URL =
  process.env.APP_URL || process.env.CORS_ORIGIN || 'https://mespoches.app'

export const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || 'MES POCHES'
