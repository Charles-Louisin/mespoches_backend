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

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Number(process.env.OPENROUTER_TIMEOUT_MS || 20_000))
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
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
        signal: controller.signal,
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`OpenRouter ${params.model}: délai dépassé`)
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }

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

  async transcribeAudio(base64: string, mimeType = 'audio/mp4'): Promise<string> {
    this.ensureConfigured()
    const raw = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64
    const buffer = Buffer.from(raw, 'base64')
    if (!buffer.length) throw new Error('Audio vide')

    const ext = mimeType.includes('webm')
      ? 'webm'
      : mimeType.includes('wav')
        ? 'wav'
        : mimeType.includes('mpeg') || mimeType.includes('mp3')
          ? 'mp3'
          : 'm4a'
    const model = process.env.OPENROUTER_WHISPER_MODEL?.trim() || 'openai/whisper-large-v3'
    const form = new FormData()
    form.append(
      'file',
      new Blob([new Uint8Array(buffer)], { type: mimeType || 'audio/mp4' }),
      `voice.${ext}`
    )
    form.append('model', model)
    form.append('language', 'fr')

    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'HTTP-Referer': OPENROUTER_SITE_URL,
        'X-Title': OPENROUTER_APP_NAME,
      },
      body: form,
    })
    const body = await res.text()
    let data: { text?: string; error?: { message?: string } }
    try {
      data = JSON.parse(body) as typeof data
    } catch {
      throw new Error(`OpenRouter transcription illisible (HTTP ${res.status})`)
    }
    if (!res.ok) {
      throw new Error(data.error?.message || `Transcription audio impossible (HTTP ${res.status})`)
    }
    const text = (data.text || '').trim()
    if (!text) throw new Error('Aucun mot reconnu dans l’audio')
    return text
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
