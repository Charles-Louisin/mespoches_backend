import { Types } from 'mongoose'
import PendingTransaction, { IPendingTransaction } from '../../models/PendingTransaction'
import Wallet from '../../models/Wallet'
import type { ImageAnalysisResult } from './ImageAnalysisService'
import type { ParsedMobileMoney } from '../../utils/mobileMoneySmsParser'

/**
 * Crée uniquement des brouillons (status pending = pending_validation).
 * Jamais de transaction validée / débit confirmé.
 */
export class TransactionDraftService {
  async getDefaultWalletId(userId: Types.ObjectId): Promise<Types.ObjectId | null> {
    const w = await Wallet.findOne({ user_id: userId, is_deleted: { $ne: true } }).sort({
      created_at: 1,
    })
    return w?._id ?? null
  }

  async createFromParsedNotification(params: {
    userId: Types.ObjectId
    parsed: ParsedMobileMoney
    rawText: string
    source: 'sms' | 'notification'
    /** Niveau 3 IA */
    fromAi?: boolean
    wallet_id?: Types.ObjectId | null
    category_id?: Types.ObjectId | null
    description?: string
    type?: 'income' | 'expense'
    confidence?: number
    ai_enriched?: boolean
    warning?: string
  }): Promise<IPendingTransaction> {
    return PendingTransaction.create({
      user_id: params.userId,
      status: 'pending',
      source: params.source,
      source_type: params.fromAi ? 'ai' : 'parser',
      type: params.type ?? params.parsed.type,
      amount: params.parsed.amount,
      operator: params.parsed.operator,
      counterparty: params.parsed.counterparty,
      description: params.description ?? params.parsed.description,
      date: params.parsed.date,
      raw_text: params.rawText.trim(),
      wallet_id: params.wallet_id ?? null,
      category_id: params.category_id ?? null,
      confidence: params.confidence ?? params.parsed.confidence,
      pattern: params.parsed.pattern,
      transaction_id: params.parsed.transaction_id,
      ai_enriched: params.ai_enriched ?? !!params.fromAi,
      low_confidence_warning: params.warning || undefined,
      document_type: undefined,
    })
  }

  async createFromImageAnalysis(params: {
    userId: Types.ObjectId
    analysis: ImageAnalysisResult
  }): Promise<IPendingTransaction[]> {
    const wallet_id = await this.getDefaultWalletId(params.userId)
    const created: IPendingTransaction[] = []
    const analysis = params.analysis

    for (const item of analysis.items) {
      const itemConfidence = item.confidence ?? analysis.confidence
      const doc = await PendingTransaction.create({
        user_id: params.userId,
        status: 'pending',
        source: 'ai_scan',
        source_type: 'image',
        type: item.type,
        amount: item.amount,
        operator: 'unknown',
        counterparty: '',
        description: item.description,
        date: item.date ? new Date(item.date) : new Date(),
        raw_text: analysis.summary,
        wallet_id,
        confidence: itemConfidence,
        pattern: 'unknown',
        ai_enriched: true,
        document_type: analysis.document_type,
        low_confidence_warning: analysis.warning,
        ai_items: analysis.items.map((i) => ({
          description: i.description,
          amount: i.amount,
          type: i.type,
        })),
      })
      created.push(doc)
    }

    return created
  }

  /**
   * Évite les doublons SMS + notification / re-posts Android pour le même événement.
   * Ordre : transaction_id → raw_text exact → chevauchement texte → montant+type+opérateur récents.
   */
  async findDuplicate(
    userId: Types.ObjectId,
    text: string,
    parsed: Pick<ParsedMobileMoney, 'transaction_id' | 'amount' | 'type' | 'operator' | 'counterparty'>
  ): Promise<IPendingTransaction | null> {
    const trimmed = text.trim()
    const transactionId = (parsed.transaction_id || '').trim()

    if (transactionId) {
      const byTx = await PendingTransaction.findOne({
        user_id: userId,
        status: 'pending',
        transaction_id: transactionId,
      })
      if (byTx) return byTx
    }

    const exact = await PendingTransaction.findOne({
      user_id: userId,
      status: 'pending',
      raw_text: trimmed,
    })
    if (exact) return exact

    const since = new Date(Date.now() - 30 * 60 * 1000)
    const recent = await PendingTransaction.find({
      user_id: userId,
      status: 'pending',
      created_at: { $gte: since },
    }).sort({ created_at: -1 }).limit(40)

    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
    const needle = norm(trimmed)
    const party = norm(parsed.counterparty || '')

    for (const cand of recent) {
      const hay = norm(cand.raw_text || '')
      if (!hay) continue

      // Même message sous forme SMS vs notif (l'un contient l'autre)
      if (needle.length >= 40 && hay.length >= 40) {
        if (hay.includes(needle) || needle.includes(hay)) return cand
      }

      if (cand.amount !== parsed.amount || cand.type !== parsed.type) continue
      if (cand.operator !== 'unknown' && parsed.operator !== 'unknown' && cand.operator !== parsed.operator) {
        continue
      }

      const candParty = norm(cand.counterparty || '')
      if (party && candParty && party !== candParty) continue

      return cand
    }

    return null
  }
}

export const transactionDraftService = new TransactionDraftService()
