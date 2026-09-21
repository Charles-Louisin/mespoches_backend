import type { OpenRouterChatMessage, OpenRouterCompletionResult } from './types'

const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')

/**
 * Client OpenAI payant (gpt-4o-mini + whisper-1).
 * Prioritaire dès que OPENAI_API_KEY est présent.
 */
export class OpenAiService {
  private readonly apiKey: string

  constructor(apiKey = process.env.OPENAI_API_KEY?.trim() || '') {
    this.apiKey = apiKey
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey)
  }

  ensureConfigured(): void {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY non configurée sur le serveur')
  }

  async chatCompletion(params: {
    model?: string
    messages: OpenRouterChatMessage[]
    temperature?: number
    maxTokens?: number
  }): Promise<OpenRouterCompletionResult> {
    this.ensureConfigured()
    const started = Date.now()
    const model = params.model || process.env.OPENAI_CHAT_MODEL?.trim() || 'gpt-4o-mini'
    const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || process.env.OPENROUTER_TIMEOUT_MS || 90_000)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    let res: Response
    try {
      res = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: params.messages,
          temperature: params.temperature ?? 0.1,
          max_tokens: params.maxTokens ?? 2048,
        }),
        signal: controller.signal,
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`OpenAI ${model}: délai dépassé`)
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }

    const raw = await res.text()
    let data: {
      error?: { message?: string }
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      model?: string
    }
    try {
      data = JSON.parse(raw) as typeof data
    } catch {
      throw new Error(`OpenAI réponse invalide (HTTP ${res.status})`)
    }
    if (!res.ok) {
      throw new Error(`OpenAI ${model}: ${data.error?.message || raw.slice(0, 200) || `HTTP ${res.status}`}`)
    }
    const content = normalizeMessageContent(data.choices?.[0]?.message?.content)
    if (!content) throw new Error(`OpenAI ${model}: réponse vide`)
    return {
      content,
      model: data.model || model,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
      latencyMs: Date.now() - started,
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
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType || 'audio/mp4' }), `voice.${ext}`)
    form.append('model', process.env.OPENAI_WHISPER_MODEL?.trim() || 'whisper-1')
    form.append('language', 'fr')

    const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || process.env.OPENROUTER_TIMEOUT_MS || 90_000)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: controller.signal,
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('OpenAI whisper-1: délai dépassé')
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }
    const body = await res.text()
    let data: { text?: string; error?: { message?: string } }
    try {
      data = JSON.parse(body) as typeof data
    } catch {
      throw new Error(`Transcription audio illisible (HTTP ${res.status})`)
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

export const openAiService = new OpenAiService()
