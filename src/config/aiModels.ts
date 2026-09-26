/**
 * Configuration des modèles OpenRouter — 4 modèles payants.
 * Les IDs `:free` sont ignorés (quotas, souvent down, 0 crédit débité).
 */

export type AiModelConfig = {
  id: string
  label: string
  /** Vision = images ; text = notifications / SMS */
  modality: 'vision' | 'text' | 'both'
}

const DEFAULT_VISION = 'google/gemini-2.5-flash'
const DEFAULT_TEXT = 'openai/gpt-4o-mini'
const DEFAULT_FALLBACK = 'google/gemini-2.0-flash-001'
const DEFAULT_WHISPER = 'openai/whisper-large-v3'

export function isFreeOpenRouterModel(id: string): boolean {
  const n = id.trim().toLowerCase()
  return n.endsWith(':free') || n === 'openrouter/free' || n.includes('/free')
}

function paidModelId(raw: string | undefined, fallback: string): string {
  const id = (raw || '').trim()
  if (!id || isFreeOpenRouterModel(id)) return fallback
  return id
}

function uniqueModels(ids: string[], modality: AiModelConfig['modality']): AiModelConfig[] {
  const seen = new Set<string>()
  const out: AiModelConfig[] = []
  for (const id of ids) {
    if (!id || seen.has(id) || isFreeOpenRouterModel(id)) continue
    seen.add(id)
    out.push({ id, label: id, modality })
  }
  return out
}

/** Images (scan ticket). */
export const OPENROUTER_VISION_MODEL = paidModelId(
  process.env.OPENROUTER_VISION_MODEL || process.env.OPENROUTER_VISION_MODEL_1,
  DEFAULT_VISION
)

/** Texte (SMS / notifications / briefing / voix après Whisper). */
export const OPENROUTER_TEXT_MODEL = paidModelId(
  process.env.OPENROUTER_TEXT_MODEL || process.env.OPENROUTER_TEXT_MODEL_1,
  DEFAULT_TEXT
)

/** Repli si le modèle principal est down. */
export const OPENROUTER_FALLBACK_MODEL = paidModelId(
  process.env.OPENROUTER_FALLBACK_MODEL ||
    process.env.OPENROUTER_VISION_MODEL_3 ||
    process.env.OPENROUTER_TEXT_MODEL_3,
  DEFAULT_FALLBACK
)

export const OPENROUTER_WHISPER_MODEL = paidModelId(
  process.env.OPENROUTER_WHISPER_MODEL,
  DEFAULT_WHISPER
)

/** Ordre de fallback Vision (scan ticket) — modèles payants. */
export const VISION_MODELS: AiModelConfig[] = uniqueModels(
  [OPENROUTER_VISION_MODEL, OPENROUTER_TEXT_MODEL, OPENROUTER_FALLBACK_MODEL],
  'both'
)

/** Ordre de fallback texte (SMS / notifications / voix). */
export const TEXT_MODELS: AiModelConfig[] = uniqueModels(
  [OPENROUTER_TEXT_MODEL, OPENROUTER_VISION_MODEL, OPENROUTER_FALLBACK_MODEL],
  'text'
)

/** Seuil en dessous duquel on signale une faible confiance à l'utilisateur. */
export const LOW_CONFIDENCE_THRESHOLD = 0.75

export const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'

export const OPENROUTER_SITE_URL =
  process.env.APP_URL || process.env.CORS_ORIGIN || 'https://mespoches.app'

export const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || 'MES POCHES'
