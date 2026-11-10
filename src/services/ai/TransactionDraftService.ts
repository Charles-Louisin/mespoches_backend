import { Types } from 'mongoose'
import PendingTransaction, { IPendingTransaction } from '../../models/PendingTransaction'
import Transaction from '../../models/Transaction'
import Wallet from '../../models/Wallet'
import type { ImageAnalysisResult } from './ImageAnalysisService'
import type { ParsedMobileMoney } from '../../utils/mobileMoneySmsParser'
import type { AiVoiceTransaction } from './types'
import { resolveDraftPlacement } from '../smsHabitService'
import { groupItemsIntoBlocks } from './AIService'
import { matchCatalogCategory, type CategoryCatalog } from '../../utils/categoryCatalog'

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

  /** Catégorie du compte pour un bloc : nom proposé par l'IA (même type), sinon habitudes / indice. */
  private async placeBlock(
    userId: Types.ObjectId,
    type: 'income' | 'expense',
    description: string,
    categoryName: string | null,
    catalog?: CategoryCatalog
  ): Promise<{ wallet_id: Types.ObjectId | null; category_id: Types.ObjectId | null }> {
    const placement = await resolveDraftPlacement(userId, type, description, categoryName)
    const matched = catalog ? matchCatalogCategory(catalog, type, categoryName) : null
    return { wallet_id: placement.wallet_id, category_id: matched?.id ?? placement.category_id }
  }

  /** Libellé d'un bloc : ses lignes (« Pain, riz, tomates »), sinon la catégorie. */
  private blockDescription(items: Array<{ description: string }>, fallback: string): string {
    const names = [...new Set(items.map((i) => i.description.trim()).filter(Boolean))]
    if (!names.length) return fallback
    const joined = names.slice(0, 5).join(', ')
    return (names.length > 5 ? `${joined}… (${names.length} lignes)` : joined).slice(0, 200)
  }

  private mapLineItems(
    items: Array<{
      description: string
      amount: number
      quantity?: number
      unit_amount?: number | null
      type: 'income' | 'expense'
    }>
  ): Array<{
    description: string
    amount: number
    quantity?: number
    unit_amount?: number
    type: 'income' | 'expense'
  }> {
    return items.map((i) => ({
      description: i.description,
      amount: i.amount,
      quantity: i.quantity && i.quantity > 1 ? i.quantity : 1,
      unit_amount: i.unit_amount ?? undefined,
      type: i.type,
    }))
  }

  /**
   * Photo : une proposition par BLOC (même sens + même catégorie du compte), chacune avec ses lignes.
   * Ex. relevé : « Alimentation » (dépenses), « Transport » (dépenses), « Salaire » (revenu).
   */
  async createFromImageAnalysis(params: {
    userId: Types.ObjectId
    analysis: ImageAnalysisResult
    catalog?: CategoryCatalog
  }): Promise<IPendingTransaction[]> {
    const analysis = params.analysis
    const created: IPendingTransaction[] = []
    for (const block of groupItemsIntoBlocks(analysis.items)) {
      const total = block.items.reduce((s, i) => s + i.amount, 0)
      const firstDate = block.items.find((i) => i.date)?.date
      const description = this.blockDescription(
        block.items,
        block.category || (block.type === 'expense' ? 'Dépense' : 'Revenu')
      )
      const placement = await this.placeBlock(params.userId, block.type, description, block.category, params.catalog)
      const doc = await PendingTransaction.create({
        user_id: params.userId,
        status: 'pending',
        source: 'ai_scan',
        source_type: 'image',
        type: block.type,
        amount: total,
        operator: 'unknown',
        counterparty: '',
        description,
        date: firstDate ? new Date(firstDate) : new Date(),
        raw_text: analysis.summary,
        wallet_id: placement.wallet_id,
        category_id: placement.category_id,
        confidence: analysis.confidence,
        pattern: 'unknown',
        ai_enriched: true,
        document_type: analysis.document_type,
        low_confidence_warning: analysis.warning,
        ai_items: this.lineItemsWithCategories(block.items, block.type, placement.category_id, params.catalog),
      })
      created.push(doc)
    }
    return created
  }

  /** Lignes avec leur catégorie : celle proposée pour la ligne si elle existe dans le compte, sinon celle du bloc. */
  private lineItemsWithCategories(
    items: Array<{ description: string; amount: number; quantity?: number; unit_amount?: number | null; type: 'income' | 'expense'; category?: string | null }>,
    type: 'income' | 'expense',
    blockCategoryId: Types.ObjectId | null,
    catalog?: CategoryCatalog
  ) {
    return this.mapLineItems(items).map((line, idx) => ({
      ...line,
      category_id: (catalog ? matchCatalogCategory(catalog, type, items[idx].category)?.id : null) ?? blockCategoryId,
    }))
  }

  async createFromVoiceTransactions(params: {
    userId: Types.ObjectId
    spokenText: string
    transactions: AiVoiceTransaction[]
    warning?: string
    fromParser?: boolean
    catalog?: CategoryCatalog
  }): Promise<IPendingTransaction[]> {
    const created: IPendingTransaction[] = []
    for (const tx of params.transactions) {
      const lineItems = tx.items?.length ? this.mapLineItems(tx.items) : []
      const amount =
        lineItems.length > 0 ? lineItems.reduce((s, i) => s + i.amount, 0) : tx.amount
      const description = tx.description || (tx.type === 'income' ? 'Revenu vocal' : 'Dépense vocale')
      const placement = await this.placeBlock(params.userId, tx.type, description, tx.category_hint, params.catalog)

      const doc = await PendingTransaction.create({
        user_id: params.userId,
        status: 'pending',
        source: 'voice',
        source_type: 'voice',
        type: tx.type,
        amount,
        operator: 'unknown',
        counterparty: '',
        description,
        date: tx.date ? new Date(tx.date) : new Date(),
        raw_text: params.spokenText.trim(),
        wallet_id: placement.wallet_id,
        category_id: placement.category_id,
        confidence: tx.confidence,
        pattern: 'unknown',
        ai_enriched: !params.fromParser,
        document_type: 'voice_note',
        low_confidence_warning: params.warning,
        ai_items: tx.items?.length
          ? this.lineItemsWithCategories(tx.items, tx.type, placement.category_id, params.catalog)
          : lineItems,
      })
      created.push(doc)
    }
    return created
  }

  /**
   * Évite les doublons SMS + notification / re-posts Android pour le même événement.
   * Ordre : transaction_id → raw_text exact → chevauchement texte → montant+type+opérateur récents.
   * Inclut les pending déjà validées et les transactions définitives.
   */
  async findDuplicate(
    userId: Types.ObjectId,
    text: string,
    parsed: Pick<ParsedMobileMoney, 'transaction_id' | 'amount' | 'type' | 'operator' | 'counterparty'>
  ): Promise<IPendingTransaction | null> {
    const match = await this.findDuplicateMatch(userId, text, parsed)
    return match?.item ?? null
  }

  async findDuplicateMatch(
    userId: Types.ObjectId,
    text: string,
    parsed: Pick<ParsedMobileMoney, 'transaction_id' | 'amount' | 'type' | 'operator' | 'counterparty'>
  ): Promise<{ item: IPendingTransaction | null; alreadyValidated: boolean } | null> {
    const trimmed = text.trim()
    const transactionId = (parsed.transaction_id || '').trim()
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
    const needle = norm(trimmed)
    const party = norm(parsed.counterparty || '')

    const matchPending = (doc: IPendingTransaction) => ({
      item: doc,
      alreadyValidated: doc.status === 'validated',
    })

    if (transactionId) {
      const byTx = await PendingTransaction.findOne({
        user_id: userId,
        transaction_id: transactionId,
        status: { $in: ['pending', 'validated'] },
      }).sort({ created_at: -1 })
      if (byTx) return matchPending(byTx)
    }

    const exact = await PendingTransaction.findOne({
      user_id: userId,
      raw_text: trimmed,
      status: { $in: ['pending', 'validated'] },
    }).sort({ created_at: -1 })
    if (exact) return matchPending(exact)

    const since = new Date(Date.now() - 30 * 60 * 1000)
    const recent = await PendingTransaction.find({
      user_id: userId,
      status: { $in: ['pending', 'validated'] },
      created_at: { $gte: since },
    })
      .sort({ created_at: -1 })
      .limit(60)

    for (const cand of recent) {
      const hay = norm(cand.raw_text || '')
      if (!hay) continue

      if (needle.length >= 40 && hay.length >= 40) {
        if (hay.includes(needle) || needle.includes(hay)) return matchPending(cand)
      }

      if (cand.amount !== parsed.amount || cand.type !== parsed.type) continue
      if (cand.operator !== 'unknown' && parsed.operator !== 'unknown' && cand.operator !== parsed.operator) {
        continue
      }

      const candParty = norm(cand.counterparty || '')
      if (party && candParty && party !== candParty) continue

      return matchPending(cand)
    }

    const hint = party || needle.slice(0, 32)
    if (hint.length >= 4) {
      const dayStart = new Date()
      dayStart.setHours(0, 0, 0, 0)
      const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const recorded = await Transaction.findOne({
        user_id: userId,
        amount: parsed.amount,
        type: parsed.type,
        date: { $gte: dayStart },
        description: { $regex: escaped, $options: 'i' },
      })
      if (recorded) return { item: null, alreadyValidated: true }
    }

    return null
  }
}

export const transactionDraftService = new TransactionDraftService()
