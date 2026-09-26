import { TEXT_MODELS, VISION_MODELS } from '../../config/aiModels'
import { extractJsonObject, formatAiError, isRetryableOpenRouterError } from './aiLogger'
import { modelFallbackService, ModelFallbackService } from './ModelFallbackService'
import { openAiService } from './OpenAiService'
import { openRouterService } from './OpenRouterService'
import { promptBuilder, PromptBuilder } from './PromptBuilder'
import type {
  AiImageExtraction,
  AiImageItem,
  AiNotificationExtraction,
  AiVoiceExtraction,
  AiVoiceTransaction,
  AiMonthBriefing,
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
    const useOpenRouter = Boolean(process.env.OPENROUTER_API_KEY?.trim())
    if (!useOpenRouter && openAiService.isConfigured()) {
      try {
        const result = await openAiService.chatCompletion({
          model: process.env.OPENAI_CHAT_MODEL?.trim() || 'gpt-4o-mini',
          messages: params.messages,
        })
        const raw = extractJsonObject(result.content)
        if (!raw) throw new Error('Réponse IA illisible (JSON attendu)')
        return { json: JSON.parse(raw), model: result.model }
      } catch (err) {
        if (!isRetryableOpenRouterError(err)) throw err
      }
    }

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

  async transcribeAudio(base64: string, mimeType: string): Promise<string> {
    const useOpenRouter = Boolean(process.env.OPENROUTER_API_KEY?.trim())
    if (!useOpenRouter && openAiService.isConfigured()) {
      try {
        return await openAiService.transcribeAudio(base64, mimeType)
      } catch (err) {
        if (!isRetryableOpenRouterError(err)) throw err
      }
    }
    return openRouterService.transcribeAudio(base64, mimeType)
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

  async analyzeMonthBriefing(snapshot: unknown): Promise<AiMonthBriefing> {
    const messages = this.prompts.textMessages(
      this.prompts.buildMonthBriefingPrompt(JSON.stringify(snapshot).slice(0, 6000))
    )
    const { json } = await this.completeJson({
      purpose: 'month_briefing',
      modality: 'text',
      messages,
    })
    const data = json as Partial<AiMonthBriefing>
    const mood = data.mood === 'alert' || data.mood === 'watch' || data.mood === 'good' ? data.mood : 'watch'
    const list = (value: unknown) =>
      Array.isArray(value)
        ? value.map((item) => String(item).slice(0, 180)).filter(Boolean).slice(0, 3)
        : []
    return {
      headline: data.headline ? String(data.headline).slice(0, 80) : 'Votre mois en un coup d’œil',
      mood,
      summary: data.summary ? String(data.summary).slice(0, 500) : '',
      highlights: list(data.highlights),
      alerts: list(data.alerts),
      tips: list(data.tips),
    }
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

  async analyzeVoiceText(spokenText: string): Promise<AiVoiceExtraction> {
    const messages = this.prompts.textMessages(
      this.prompts.buildVoiceTransactionPrompt(spokenText)
    )
    const { json } = await this.completeJson({
      purpose: 'voice_transaction',
      modality: 'text',
      messages,
    })
    const data = json as Record<string, unknown>
    const parsedTxs: AiVoiceTransaction[] = []

    const pushTx = (raw: Record<string, unknown>, fallbackType?: 'income' | 'expense') => {
      const items = this.normalizeLineItems(raw.items)
      const type: 'income' | 'expense' =
        raw.type === 'income' || raw.type === 'expense'
          ? raw.type
          : fallbackType ?? (items[0]?.type === 'income' ? 'income' : 'expense')
      const typedItems = items.length
        ? items.map((i) => ({
            ...i,
            type: i.type === 'income' || i.type === 'expense' ? i.type : type,
          }))
        : []
      const hasIncome = typedItems.some((i) => i.type === 'income')
      const hasExpense = typedItems.some((i) => i.type === 'expense')
      if (hasIncome && hasExpense) {
        pushTx({ ...raw, type: 'expense', items: typedItems.filter((i) => i.type === 'expense') }, 'expense')
        pushTx({ ...raw, type: 'income', items: typedItems.filter((i) => i.type === 'income') }, 'income')
        return
      }
      const amount =
        typedItems.length > 0
          ? typedItems.reduce((s, i) => s + i.amount, 0)
          : parseLooseAmount(raw.amount)
      if (!amount) return
      const description = this.voiceDescription(raw.description, typedItems)
      parsedTxs.push({
        type,
        description,
        category_hint: raw.category_hint ? String(raw.category_hint).slice(0, 80) : null,
        date: normalizeDate(raw.date),
        confidence:
          typeof raw.confidence === 'number' ? Math.min(1, Math.max(0, raw.confidence)) : 0.75,
        amount,
        items: typedItems.length
          ? typedItems
          : [{ description, amount, quantity: 1, unit_amount: amount, type }],
      })
    }

    if (Array.isArray(data.transactions)) {
      for (const raw of data.transactions) {
        if (raw && typeof raw === 'object') pushTx(raw as Record<string, unknown>)
      }
    }

    if (parsedTxs.length === 0) {
      const items = this.normalizeLineItems(data.items)
      if (items.length > 0) {
        const byType: Record<'income' | 'expense', AiImageItem[]> = { income: [], expense: [] }
        for (const item of items) {
          byType[item.type].push(item)
        }
        for (const type of ['expense', 'income'] as const) {
          if (!byType[type].length) continue
          pushTx(
            {
              type,
              description: data.description,
              category_hint: data.category_hint,
              date: data.date,
              confidence: data.confidence,
              items: byType[type],
            },
            type
          )
        }
      } else {
        pushTx(data)
      }
    }

    const grouped = this.mergeVoiceByType(parsedTxs)
    const detected = Boolean(data.detected !== false) && grouped.length > 0
    const confidence =
      typeof data.confidence === 'number'
        ? Math.min(1, Math.max(0, data.confidence))
        : grouped.length
          ? grouped.reduce((s, t) => s + t.confidence, 0) / grouped.length
          : 0

    return { detected, confidence, transactions: detected ? grouped : [] }
  }

  private voiceDescription(
    raw: unknown,
    items: Array<{ description: string }>
  ): string {
    const fromItems = [
      ...new Set(
        items
          .map((i) => i.description.trim())
          .filter((d) => d && !/^note vocale$/i.test(d) && !/^ligne\s/i.test(d))
      ),
    ]
    if (fromItems.length) return fromItems.slice(0, 6).join(', ').slice(0, 200)
    const rawText = raw ? String(raw).trim().slice(0, 200) : ''
    if (rawText && !/^note vocale$/i.test(rawText)) return rawText
    return items[0]?.description || 'Note vocale'
  }

  private normalizeLineItems(raw: unknown): AiImageItem[] {
    if (!Array.isArray(raw)) return []
    const items: AiImageItem[] = []
    for (const row of raw) {
      const i = row as Record<string, unknown>
      const lineAmount = parseLooseAmount(i.amount)
      if (!lineAmount) continue
      const quantity =
        typeof i.quantity === 'number' && i.quantity >= 1 ? Math.round(i.quantity) : 1
      const unitRaw = parseLooseAmount(i.unit_amount)
      const description = i.description
        ? String(i.description).trim().slice(0, 200)
        : ''
      items.push({
        description: description || `Ligne ${Math.round(lineAmount)} F`,
        amount: lineAmount,
        quantity,
        unit_amount: unitRaw ?? (quantity > 1 ? lineAmount / quantity : lineAmount),
        type: i.type === 'income' ? 'income' : 'expense',
      })
    }
    return items
  }

  /** Une transaction dépense + une transaction revenu, chacune avec toutes ses lignes. */
  private mergeVoiceByType(txs: AiVoiceTransaction[]): AiVoiceTransaction[] {
    const buckets: Record<'income' | 'expense', AiVoiceTransaction[]> = { income: [], expense: [] }
    for (const tx of txs) buckets[tx.type].push(tx)
    const merged: AiVoiceTransaction[] = []
    for (const type of ['expense', 'income'] as const) {
      const list = buckets[type]
      if (!list.length) continue
      const items = list.flatMap((t) => t.items)
      const amount = items.reduce((s, i) => s + i.amount, 0)
      merged.push({
        type,
        description: this.voiceDescription(
          list[0].description,
          items
        ),
        category_hint: list.find((t) => t.category_hint)?.category_hint ?? null,
        date: list.find((t) => t.date)?.date ?? null,
        confidence: list.reduce((s, t) => s + t.confidence, 0) / list.length,
        amount,
        items,
      })
    }
    return merged
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
      const quantity =
        typeof (i as { quantity?: number }).quantity === 'number' &&
        (i as { quantity?: number }).quantity! >= 1
          ? Math.round((i as { quantity: number }).quantity)
          : 1
      const unitRaw = parseLooseAmount((i as { unit_amount?: unknown }).unit_amount)
      items.push({
        description: String(i.description).slice(0, 200),
        amount,
        quantity,
        unit_amount: unitRaw ?? (quantity > 1 ? amount / quantity : amount),
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
