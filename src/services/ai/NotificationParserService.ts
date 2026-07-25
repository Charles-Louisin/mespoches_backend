import {
  extractTransactionId,
  parseMobileMoneySms,
  parseNotificationText,
  ParsedMobileMoney,
  UserSmsIdentity,
} from '../../utils/mobileMoneySmsParser'
import NotificationPattern from '../../models/NotificationPattern'
import { moneyTextFilterService, MoneyTextFilterService } from './MoneyTextFilterService'

export type ParseLevel = 'filter_reject' | 'parser' | 'learned_pattern' | null

export type ParserResult = {
  parsed: ParsedMobileMoney | null
  level: ParseLevel
  /** Texte rejeté au niveau 1 */
  rejectedByFilter?: boolean
}

/**
 * Niveau 2 — parsers spécialisés (regex) + motifs appris (ex-IA).
 * Aucune IA ici.
 */
export class NotificationParserService {
  constructor(private readonly filter: MoneyTextFilterService = moneyTextFilterService) {}

  /** Filtrage rapide Niveau 1. */
  passesLevel1(text: string, packageName?: string): boolean {
    if (packageName && this.filter.isMoneyPackage(packageName)) return true
    return this.filter.isMoneyRelated(text)
  }

  parseSms(text: string, identity?: UserSmsIdentity): ParsedMobileMoney | null {
    return parseMobileMoneySms(text, identity)
  }

  parseNotification(
    title: string,
    body: string,
    identity?: UserSmsIdentity
  ): ParsedMobileMoney | null {
    return parseNotificationText(title, body, identity)
  }

  /**
   * Essaie parsers regex puis motifs appris stockés en base.
   */
  async parseWithLearnedPatterns(
    text: string,
    identity?: UserSmsIdentity
  ): Promise<ParserResult> {
    if (!this.passesLevel1(text)) {
      return { parsed: null, level: 'filter_reject', rejectedByFilter: true }
    }

    const regexParsed = this.parseSms(text, identity)
    if (regexParsed && regexParsed.confidence >= 0.55) {
      return { parsed: regexParsed, level: 'parser' }
    }

    const learned = await this.tryLearnedPatterns(text, identity)
    if (learned) {
      return { parsed: learned, level: 'learned_pattern' }
    }

    if (regexParsed) {
      return { parsed: regexParsed, level: 'parser' }
    }

    return { parsed: null, level: null }
  }

  private async tryLearnedPatterns(
    text: string,
    identity?: UserSmsIdentity
  ): Promise<ParsedMobileMoney | null> {
    const patterns = await NotificationPattern.find({ active: true })
      .sort({ hit_count: -1 })
      .limit(40)
      .lean()

    for (const p of patterns) {
      try {
        const re = new RegExp(p.regex, 'i')
        const m = text.match(re)
        if (!m) continue

        const amountRaw = m.groups?.amount ?? m[p.amount_group || 1]
        if (!amountRaw) continue
        const amount = parseFloat(String(amountRaw).replace(/\s/g, '').replace(',', '.'))
        if (!Number.isFinite(amount) || amount <= 0) continue

        await NotificationPattern.updateOne(
          { _id: p._id },
          { $inc: { hit_count: 1 }, $set: { last_hit_at: new Date() } }
        )

        const counterparty =
          (m.groups?.merchant ||
            m.groups?.sender ||
            m.groups?.recipient ||
            m[p.counterparty_group || 0] ||
            p.default_counterparty ||
            '') + ''

        return {
          amount,
          type: p.default_type || 'expense',
          operator: (p.operator as ParsedMobileMoney['operator']) || 'unknown',
          counterparty: String(counterparty).trim(),
          description: p.default_description || 'Notification financière',
          date: new Date(),
          confidence: Math.min(0.9, 0.7 + Math.min(p.hit_count, 10) * 0.02),
          pattern: (p.pattern as ParsedMobileMoney['pattern']) || 'unknown',
          transaction_id: extractTransactionId(text),
          sender_name: String(m.groups?.sender || ''),
          sender_phone: '',
          recipient_name: String(m.groups?.recipient || ''),
          recipient_phone: '',
        }
      } catch {
        /* motif invalide — ignorer */
      }
    }

    // Si un parse regex faible existe déjà, on l'a géré plus haut
    void identity
    return null
  }
}

export const notificationParserService = new NotificationParserService()
