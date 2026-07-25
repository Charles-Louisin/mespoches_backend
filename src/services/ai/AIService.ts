import { TEXT_MODELS, VISION_MODELS } from '../../config/aiModels'
import { extractJsonObject, formatAiError } from './aiLogger'
import { modelFallbackService, ModelFallbackService } from './ModelFallbackService'
import { promptBuilder, PromptBuilder } from './PromptBuilder'
import type {
  AiImageExtraction,
  AiImageItem,
  AiNotificationExtraction,
  OpenRouterChatMessage,
} from './types'

function parseLooseAmount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value
  }
  if (typeof value !== 'string') return null

  let s = value.trim().replace(/\s/g, '').replace(/fcfa|xaf|cfa|€|\$/gi, '')
  if (!s) return null

  // 1.500 / 1.500,50 (milliers EU)
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.')
  } else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    // 1,500.50 (US)
    s = s.replace(/,/g, '')
  } else if (s.includes(',') && !s.includes('.')) {
    s = s.replace(',', '.')
  }

  const n = parseFloat(s)
  return Number.isFinite(n) && n > 0 ? n : null
}

function normalizeDate(value: unknown): string | null {
  if (value == null) return null
  const s = String(value).trim()
  if (!s || /^null$/i.test(s) || /ou\s+null/i.test(s)) return null
  // Accepte YYYY-MM-DD ou ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

function requireValidJsonContent(content: string): void {
  const raw = extractJsonObject(content)
  if (!raw) {
    throw new Error('Réponse IA illisible (JSON attendu)')
  }
  try {
    JSON.parse(raw)
  } catch {
    throw new Error('Réponse IA illisible (JSON invalide)')
  }
}

/**
 * Façade IA — point d'entrée unique pour image / texte.
 */
export class AIService {
  constructor(
    private readonly fallback: ModelFallbackService = modelFallbackService,
    private readonly prompts: PromptBuilder = promptBuilder
  ) {}

  async completeJson(params: {
    purpose: string
    modality: 'vision' | 'text'
    messages: OpenRouterChatMessage[]
  }): Promise<{ json: unknown; model: string; confidence?: number }> {
    const models = params.modality === 'vision' ? VISION_MODELS : TEXT_MODELS
    const result = await this.fallback.completeWithFallback({
      purpose: params.purpose,
      models,
      messages: params.messages,
      validateContent: requireValidJsonContent,
    })

    const raw = extractJsonObject(result.content)
    if (!raw) {
      throw new Error('Réponse IA illisible (JSON attendu)')
    }

    try {
      return { json: JSON.parse(raw), model: result.model }
    } catch {
      throw new Error('Réponse IA illisible (JSON invalide)')
    }
  }

  async analyzeImage(base64OrDataUrl: string, mimeType: string): Promise<AiImageExtraction> {
    const dataUrl = base64OrDataUrl.startsWith('data:')
      ? base64OrDataUrl
      : `data:${mimeType || 'image/jpeg'};base64,${base64OrDataUrl}`

    const messages = this.prompts.imageMessages(
      this.prompts.buildImageAnalysisPrompt(),
      dataUrl
    )

    const { json, model } = await this.completeJson({
      purpose: 'image_analysis',
      modality: 'vision',
      messages,
    })

    return this.normalizeImageExtraction(json, model)
  }

  async analyzeNotificationText(text: string): Promise<AiNotificationExtraction> {
    const messages = this.prompts.textMessages(
      this.prompts.buildNotificationAnalysisPrompt(text)
    )

    const { json, model } = await this.completeJson({
      purpose: 'notification_analysis',
      modality: 'text',
      messages,
    })

    return this.normalizeNotificationExtraction(json, model)
  }

  async enrichSms(
    rawSms: string,
    parsedSummary: string,
    habitsBlock: string
  ): Promise<Record<string, unknown> | null> {
    try {
      const messages = this.prompts.textMessages(
        this.prompts.buildSmsEnrichmentPrompt(rawSms, parsedSummary, habitsBlock)
      )
      const { json } = await this.completeJson({
        purpose: 'sms_enrichment',
        modality: 'text',
        messages,
      })
      return json as Record<string, unknown>
    } catch {
      return null
    }
  }

  formatError(err: unknown): string {
    return formatAiError(err)
  }

  private normalizeImageExtraction(json: unknown, _model: string): AiImageExtraction {
    const data = json as Partial<AiImageExtraction>
    const allowedTypes = new Set([
      'receipt',
      'invoice',
      'screenshot',
      'sms_mobile_money',
      'sms_bank',
      'handwritten_list',
      'handwritten_note',
      'other_financial',
    ])

    const items: AiImageItem[] = []
    for (const i of data.items || []) {
      if (!i || !i.description) continue
      const amount = parseLooseAmount(i.amount)
      if (!amount) continue
      items.push({
        description: String(i.description).slice(0, 200),
        amount,
        type: i.type === 'income' ? 'income' : 'expense',
        date: normalizeDate(i.date),
        currency: i.currency || 'XAF',
        confidence:
          typeof i.confidence === 'number'
            ? Math.min(1, Math.max(0, i.confidence))
            : undefined,
      })
    }

    if (items.length === 0) {
      throw new Error('Aucune transaction détectée sur l\'image')
    }

    const confidence =
      typeof data.confidence === 'number'
        ? Math.min(1, Math.max(0, data.confidence))
        : items.reduce((s, i) => s + (i.confidence ?? 0.8), 0) / items.length

    const document_type = allowedTypes.has(String(data.document_type))
      ? (data.document_type as AiImageExtraction['document_type'])
      : 'other_financial'

    return {
      document_type,
      summary: String(data.summary || 'Document financier').slice(0, 300),
      confidence,
      items,
    }
  }

  private normalizeNotificationExtraction(
    json: unknown,
    _model: string
  ): AiNotificationExtraction {
    const data = json as Partial<AiNotificationExtraction>
    const amount = parseLooseAmount(data.amount)
    const detected = Boolean(data.detected) && amount != null && amount > 0
    const confidence =
      typeof data.confidence === 'number'
        ? Math.min(1, Math.max(0, data.confidence))
        : detected
          ? 0.7
          : 0

    return {
      detected,
      amount: detected ? amount : null,
      currency: data.currency ? String(data.currency) : 'XAF',
      type: data.type === 'income' ? 'income' : data.type === 'expense' ? 'expense' : null,
      date: normalizeDate(data.date),
      sender: data.sender ? String(data.sender) : null,
      recipient: data.recipient ? String(data.recipient) : null,
      merchant: data.merchant ? String(data.merchant) : null,
      description: data.description ? String(data.description).slice(0, 200) : null,
      operator:
        data.operator === 'orange' ||
        data.operator === 'mtn' ||
        data.operator === 'wave' ||
        data.operator === 'bank'
          ? data.operator
          : 'unknown',
      pattern:
        data.pattern === 'transfer_out' ||
        data.pattern === 'transfer_in' ||
        data.pattern === 'payment' ||
        data.pattern === 'withdrawal' ||
        data.pattern === 'deposit'
          ? data.pattern
          : 'unknown',
      confidence,
      generalized_pattern: data.generalized_pattern
        ? String(data.generalized_pattern).slice(0, 500)
        : null,
    }
  }
}

export const aiService = new AIService()
