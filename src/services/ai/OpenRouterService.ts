import {
  OPENROUTER_APP_NAME,
  OPENROUTER_BASE_URL,
  OPENROUTER_SITE_URL,
} from '../../config/aiModels'
import type { OpenRouterChatMessage, OpenRouterCompletionResult } from './types'

/**
 * Client HTTP unique vers OpenRouter (API compatible OpenAI).
 * Changer de fournisseur = toucher surtout cette classe.
 */
export class OpenRouterService {
  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(apiKey = process.env.OPENROUTER_API_KEY?.trim() || '') {
    this.apiKey = apiKey
    this.baseUrl = OPENROUTER_BASE_URL.replace(/\/$/, '')
  }

  ensureConfigured(): void {
    if (!this.apiKey) {
      throw new Error('OPENROUTER_API_KEY non configurée sur le serveur')
    }
  }

  async chatCompletion(params: {
    model: string
    messages: OpenRouterChatMessage[]
    temperature?: number
    maxTokens?: number
  }): Promise<OpenRouterCompletionResult> {
    this.ensureConfigured()
    const started = Date.now()

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': OPENROUTER_SITE_URL,
        'X-Title': OPENROUTER_APP_NAME,
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        temperature: params.temperature ?? 0.1,
        max_tokens: params.maxTokens ?? 2048,
      }),
    })

    const latencyMs = Date.now() - started
    const raw = await res.text()
    let data: {
      error?: { message?: string; code?: string }
      choices?: Array<{
        message?: { content?: string | Array<{ type?: string; text?: string }> }
        finish_reason?: string
      }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
      }
      model?: string
    }

    try {
      data = JSON.parse(raw) as typeof data
    } catch {
      throw new Error(`OpenRouter réponse invalide (HTTP ${res.status})`)
    }

    if (!res.ok) {
      const errMsg = data.error?.message || raw.slice(0, 200) || `HTTP ${res.status}`
      throw new Error(`OpenRouter ${params.model}: ${errMsg}`)
    }

    const choice = data.choices?.[0]
    const finish = (choice?.finish_reason || '').toLowerCase()
    if (finish.includes('content_filter') || finish.includes('safety')) {
      throw new Error(`OpenRouter ${params.model}: content_filter / refused`)
    }

    const content = normalizeMessageContent(choice?.message?.content)
    if (!content) {
      throw new Error(`OpenRouter ${params.model}: réponse vide`)
    }

    return {
      content,
      model: data.model || params.model,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
      latencyMs,
    }
  }
}

function normalizeMessageContent(
  content: string | Array<{ type?: string; text?: string }> | undefined | null
): string {
  if (!content) return ''
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim()
  }
  return ''
}

export const openRouterService = new OpenRouterService()
