import type { AiModelConfig } from '../../config/aiModels'
import { logAiCall, isRetryableOpenRouterError, sleep } from './aiLogger'
import { openRouterService, OpenRouterService } from './OpenRouterService'
import type { OpenRouterChatMessage, OpenRouterCompletionResult } from './types'

export type FallbackResult = OpenRouterCompletionResult & {
  fallbackReason?: string
  attemptedModels: string[]
}

/**
 * Essaye les modèles dans l'ordre configuré jusqu'à succès.
 * Une réponse HTTP OK mais inutilisable (vide / JSON invalide) passe au modèle suivant.
 */
export class ModelFallbackService {
  constructor(private readonly client: OpenRouterService = openRouterService) {}

  async completeWithFallback(params: {
    purpose: string
    models: AiModelConfig[]
    messages: OpenRouterChatMessage[]
    temperature?: number
    maxTokens?: number
    /** Si fourni, une exception = contenu inutilisable → modèle suivant. */
    validateContent?: (content: string) => void
  }): Promise<FallbackResult> {
    if (!params.models.length) {
      throw new Error('Aucun modèle IA configuré')
    }

    const attemptedModels: string[] = []
    let lastError: Error | null = null
    let fallbackReason: string | undefined

    for (let i = 0; i < params.models.length; i++) {
      const model = params.models[i]
      attemptedModels.push(model.id)

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await this.client.chatCompletion({
            model: model.id,
            messages: params.messages,
            temperature: params.temperature,
            maxTokens: params.maxTokens,
          })

          if (params.validateContent) {
            params.validateContent(result.content)
          }

          logAiCall({
            purpose: params.purpose,
            model: result.model,
            latencyMs: result.latencyMs,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            totalTokens: result.totalTokens,
            fallbackReason,
            success: true,
          })

          return { ...result, fallbackReason, attemptedModels }
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e))
          const reason = lastError.message

          logAiCall({
            purpose: params.purpose,
            model: model.id,
            latencyMs: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            fallbackReason: reason,
            success: false,
            error: reason,
          })

          if (attempt === 0 && /429|rate limit|quota/i.test(reason)) {
            await sleep(2000)
            continue
          }

          if (isRetryableOpenRouterError(e)) {
            fallbackReason = `${model.label} indisponible: ${reason}`
            break
          }

          // Erreur non retryable (ex. clé API) → stop immédiat
          throw lastError
        }
      }
    }

    throw new Error(
      `Tous les modèles IA ont échoué (${attemptedModels.join(' → ')}). ${
        lastError?.message || ''
      }`.trim()
    )
  }
}

export const modelFallbackService = new ModelFallbackService()
