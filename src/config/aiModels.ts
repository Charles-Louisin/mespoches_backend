/**
 * Configuration des modèles OpenRouter.
 * Modifiable via variables d'environnement ou en éditant ces listes.
 *
 * IDs vérifiés sur https://openrouter.ai/api/v1/models (tier :free).
 */

export type AiModelConfig = {
  id: string
  label: string
  /** Vision = images ; text = notifications / SMS */
  modality: 'vision' | 'text' | 'both'
}

/** Ordre de fallback Vision (analyse d'images) — modèles gratuits OpenRouter vivants. */
export const VISION_MODELS: AiModelConfig[] = [
  {
    id: process.env.OPENROUTER_VISION_MODEL_1 || 'google/gemma-4-31b-it:free',
    label: 'Gemma 4 31B',
    modality: 'both',
  },
  {
    id: process.env.OPENROUTER_VISION_MODEL_2 || 'google/gemma-4-26b-a4b-it:free',
    label: 'Gemma 4 26B',
    modality: 'both',
  },
  {
    id: process.env.OPENROUTER_VISION_MODEL_3 || 'nvidia/nemotron-nano-12b-v2-vl:free',
    label: 'Nemotron Nano VL',
    modality: 'vision',
  },
  {
    id:
      process.env.OPENROUTER_VISION_MODEL_4 ||
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    label: 'Nemotron Omni',
    modality: 'vision',
  },
  {
    id: process.env.OPENROUTER_VISION_MODEL_5 || 'openrouter/free',
    label: 'OpenRouter Free Router',
    modality: 'both',
  },
]

/** Ordre de fallback texte (notifications / SMS). */
export const TEXT_MODELS: AiModelConfig[] = [
  {
    id: process.env.OPENROUTER_TEXT_MODEL_1 || 'google/gemma-4-31b-it:free',
    label: 'Gemma 4 31B',
    modality: 'both',
  },
  {
    id: process.env.OPENROUTER_TEXT_MODEL_2 || 'openai/gpt-oss-20b:free',
    label: 'GPT-OSS 20B',
    modality: 'text',
  },
  {
    id: process.env.OPENROUTER_TEXT_MODEL_3 || 'nvidia/nemotron-3-nano-30b-a3b:free',
    label: 'Nemotron Nano 30B',
    modality: 'text',
  },
  {
    id: process.env.OPENROUTER_TEXT_MODEL_4 || 'openrouter/free',
    label: 'OpenRouter Free Router',
    modality: 'text',
  },
]

/** Seuil en dessous duquel on signale une faible confiance à l'utilisateur. */
export const LOW_CONFIDENCE_THRESHOLD = 0.75

export const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'

export const OPENROUTER_SITE_URL =
  process.env.APP_URL || process.env.CORS_ORIGIN || 'https://mespoches.app'

export const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || 'MES POCHES'
