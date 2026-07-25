import { LOW_CONFIDENCE_THRESHOLD } from '../../config/aiModels'
import NotificationPattern from '../../models/NotificationPattern'
import {
  extractTransactionId,
  type ParsedMobileMoney,
} from '../../utils/mobileMoneySmsParser'
import { logAiCall } from './aiLogger'
import { aiService, AIService } from './AIService'
import {
  notificationParserService,
  NotificationParserService,
} from './NotificationParserService'
import type { AiNotificationExtraction } from './types'

export type NotificationAnalysisOutcome = {
  parsed: ParsedMobileMoney | null
  /** parser | learned_pattern | ai | rejected */
  sourceLevel: 'filter_reject' | 'parser' | 'learned_pattern' | 'ai' | 'none'
  lowConfidence: boolean
  warning?: string
  aiExtraction?: AiNotificationExtraction
}

/**
 * Orchestration Niveau 1 → 2 → 3 pour notifications / SMS.
 */
export class NotificationAnalysisService {
  constructor(
    private readonly parser: NotificationParserService = notificationParserService,
    private readonly ai: AIService = aiService
  ) {}

  async analyze(
    text: string,
    identity?: Parameters<NotificationParserService['parseSms']>[1],
    options?: { packageName?: string; allowAi?: boolean }
  ): Promise<NotificationAnalysisOutcome> {
    if (!this.parser.passesLevel1(text, options?.packageName)) {
      return {
        parsed: null,
        sourceLevel: 'filter_reject',
        lowConfidence: false,
      }
    }

    const level2 = await this.parser.parseWithLearnedPatterns(text, identity)
    if (level2.parsed && level2.level) {
      return {
        parsed: level2.parsed,
        sourceLevel: level2.level,
        lowConfidence: level2.parsed.confidence < LOW_CONFIDENCE_THRESHOLD,
        warning:
          level2.parsed.confidence < LOW_CONFIDENCE_THRESHOLD
            ? 'Certaines informations n\'ont pas pu être reconnues avec certitude.'
            : undefined,
      }
    }

    if (options?.allowAi === false) {
      return { parsed: null, sourceLevel: 'none', lowConfidence: false }
    }

    try {
      const extraction = await this.ai.analyzeNotificationText(text)
      if (!extraction.detected || !extraction.amount || !extraction.type) {
        return {
          parsed: null,
          sourceLevel: 'ai',
          lowConfidence: true,
          aiExtraction: extraction,
        }
      }

      const parsed = this.toParsed(extraction, text)
      await this.persistLearnedPattern(text, extraction)

      logAiCall({
        purpose: 'notification_analysis_result',
        model: 'n/a',
        latencyMs: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        confidence: extraction.confidence,
        success: true,
      })

      return {
        parsed,
        sourceLevel: 'ai',
        lowConfidence: extraction.confidence < LOW_CONFIDENCE_THRESHOLD,
        warning:
          extraction.confidence < LOW_CONFIDENCE_THRESHOLD
            ? 'Certaines informations n\'ont pas pu être reconnues avec certitude.'
            : undefined,
        aiExtraction: extraction,
      }
    } catch (e) {
      logAiCall({
        purpose: 'notification_analysis_result',
        model: 'n/a',
        latencyMs: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        success: false,
        error: e instanceof Error ? e.message : String(e),
      })
      return { parsed: null, sourceLevel: 'none', lowConfidence: false }
    }
  }

  private toParsed(extraction: AiNotificationExtraction, sourceText: string): ParsedMobileMoney {
    const counterparty =
      extraction.merchant ||
      (extraction.type === 'income' ? extraction.sender : extraction.recipient) ||
      ''

    const operator =
      extraction.operator === 'orange' || extraction.operator === 'mtn'
        ? extraction.operator
        : 'unknown'

    const pattern =
      extraction.pattern === 'transfer_out' ||
      extraction.pattern === 'transfer_in' ||
      extraction.pattern === 'payment' ||
      extraction.pattern === 'withdrawal'
        ? extraction.pattern
        : 'unknown'

    return {
      amount: extraction.amount!,
      type: extraction.type!,
      operator,
      counterparty: counterparty.trim(),
      description:
        extraction.description ||
        (extraction.type === 'income' ? 'Crédit reçu' : 'Débit détecté'),
      date: extraction.date ? new Date(extraction.date) : new Date(),
      confidence: extraction.confidence,
      pattern,
      transaction_id: extractTransactionId(sourceText),
      sender_name: extraction.sender || '',
      sender_phone: '',
      recipient_name: extraction.recipient || '',
      recipient_phone: '',
    }
  }

  /**
   * Enrichit le système : enregistre un motif généralisé pour que le parser
   * progresse et que l'IA intervienne de moins en moins.
   */
  private async persistLearnedPattern(
    text: string,
    extraction: AiNotificationExtraction
  ): Promise<void> {
    if (!extraction.generalized_pattern && !extraction.amount) return

    const fingerprint = this.fingerprint(text)
    const regex =
      this.sanitizeRegex(extraction.generalized_pattern) ||
      this.buildFallbackRegex(text)

    if (!regex) return

    try {
      await NotificationPattern.findOneAndUpdate(
        { fingerprint },
        {
          $setOnInsert: {
            fingerprint,
            regex,
            sample_text: text.slice(0, 500),
            default_type: extraction.type || 'expense',
            default_description: extraction.description || 'Notification financière',
            default_counterparty:
              extraction.merchant || extraction.sender || extraction.recipient || '',
            operator: extraction.operator || 'unknown',
            pattern: extraction.pattern || 'unknown',
            amount_group: 1,
            source: 'ai',
            active: true,
            hit_count: 0,
          },
          $inc: { learn_count: 1 },
          $set: { last_learned_at: new Date() },
        },
        { upsert: true }
      )
    } catch (e) {
      console.warn('[NotificationPattern] persist skipped:', e)
    }
  }

  private fingerprint(text: string): string {
    return text
      .toLowerCase()
      .replace(/\d[\d\s.,]*/g, '#')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200)
  }

  private sanitizeRegex(raw: string | null | undefined): string | null {
    if (!raw) return null
    const s = raw.trim()
    if (s.length < 4 || s.length > 400) return null
    try {
      // eslint-disable-next-line no-new
      new RegExp(s, 'i')
      return s
    } catch {
      return null
    }
  }

  private buildFallbackRegex(text: string): string | null {
    const amountMatch = text.match(/(\d[\d\s.,]*)\s*(?:FCFA|XAF|CFA)/i)
    if (!amountMatch) return null
    const escaped = text
      .slice(0, 120)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\d[\d\s.,]*/g, '(\\d[\\d\\s.,]*)')
    try {
      // eslint-disable-next-line no-new
      new RegExp(escaped, 'i')
      return escaped.slice(0, 350)
    } catch {
      return '(\\d[\\d\\s.,]*)\\s*(?:FCFA|XAF|CFA)'
    }
  }
}

export const notificationAnalysisService = new NotificationAnalysisService()
