import { Types } from 'mongoose';
import PendingTransaction, { IPendingTransaction } from '../models/PendingTransaction';
import Transaction from '../models/Transaction';
import Wallet from '../models/Wallet';
import {
  parseMobileMoneySms,
  ParsedMobileMoney,
} from '../utils/mobileMoneySmsParser';
import {
  applyHabitsAndAi,
  getUserSmsIdentity,
  learnFromValidation,
} from './smsHabitService';
import {
  aiService,
  imageAnalysisService,
  notificationAnalysisService,
  transactionDraftService,
} from './ai';
import { LOW_CONFIDENCE_THRESHOLD } from '../config/aiModels';
import { maybeSuggestRecurrence } from './recurrenceSuggestionService';

async function buildFromParsed(
  userId: Types.ObjectId,
  parsed: ParsedMobileMoney,
  rawText: string,
  source: 'sms' | 'notification',
  options?: {
    fromAi?: boolean;
    warning?: string;
  }
): Promise<IPendingTransaction> {
  const enriched = await applyHabitsAndAi(userId, parsed, rawText);
  const wallet_id =
    enriched.wallet_id ?? (await transactionDraftService.getDefaultWalletId(userId));

  return transactionDraftService.createFromParsedNotification({
    userId,
    parsed,
    rawText,
    source,
    fromAi: options?.fromAi,
    wallet_id,
    category_id: enriched.category_id,
    description: enriched.description,
    type: enriched.type,
    confidence: enriched.confidence,
    ai_enriched: enriched.ai_enriched || !!options?.fromAi,
    warning: options?.warning,
  });
}

export type CreatePendingResult = {
  item: IPendingTransaction;
  duplicate: boolean;
};

export async function createFromSms(
  userId: Types.ObjectId,
  text: string,
  source: 'sms' | 'notification' = 'sms'
): Promise<CreatePendingResult | null> {
  const identity = await getUserSmsIdentity(userId);
  const outcome = await notificationAnalysisService.analyze(text, identity, {
    allowAi: true,
  });

  if (!outcome.parsed) return null;

  const existing = await transactionDraftService.findDuplicate(
    userId,
    text,
    outcome.parsed
  );
  if (existing) return { item: existing, duplicate: true };

  const item = await buildFromParsed(userId, outcome.parsed, text, source, {
    fromAi: outcome.sourceLevel === 'ai',
    warning: outcome.warning,
  });
  return { item, duplicate: false };
}

export async function createFromNotification(
  userId: Types.ObjectId,
  title: string,
  body: string,
  packageName?: string
): Promise<CreatePendingResult | null> {
  const identity = await getUserSmsIdentity(userId);
  const raw = `${title}\n${body}`.trim();
  const outcome = await notificationAnalysisService.analyze(raw, identity, {
    packageName,
    allowAi: true,
  });

  if (!outcome.parsed) return null;

  const existing = await transactionDraftService.findDuplicate(
    userId,
    raw,
    outcome.parsed
  );
  if (existing) return { item: existing, duplicate: true };

  const item = await buildFromParsed(userId, outcome.parsed, raw, 'notification', {
    fromAi: outcome.sourceLevel === 'ai',
    warning: outcome.warning,
  });
  return { item, duplicate: false };
}

export type AiScanCreateResult = {
  items: IPendingTransaction[];
  warning?: string;
  confidence: number;
  document_type: string;
};

export async function createFromAiScan(
  userId: Types.ObjectId,
  base64: string,
  mimeType: string
): Promise<AiScanCreateResult> {
  const analysis = await imageAnalysisService.analyze(base64, mimeType);
  const items = await transactionDraftService.createFromImageAnalysis({
    userId,
    analysis,
  });

  return {
    items,
    warning: analysis.warning,
    confidence: analysis.confidence,
    document_type: analysis.document_type,
  };
}

export async function validatePendingTransaction(
  pending: IPendingTransaction,
  userId: Types.ObjectId,
  updates?: {
    amount?: number;
    type?: 'income' | 'expense';
    wallet_id?: string;
    category_id?: string | null;
    description?: string;
    date?: Date;
    ai_items?: Array<{
      description: string;
      amount: number;
      quantity?: number;
      unit_amount?: number;
      type?: 'income' | 'expense';
    }>;
  }
): Promise<{ pending: IPendingTransaction; transactionId: Types.ObjectId }> {
  if (pending.status !== 'pending') {
    throw new Error('Cette proposition a déjà été traitée');
  }

  const amount = updates?.amount ?? pending.amount;
  const type = updates?.type ?? pending.type;
  const walletId = updates?.wallet_id ?? pending.wallet_id;
  const description = updates?.description ?? pending.description;
  const categoryId =
    updates?.category_id !== undefined
      ? updates.category_id
      : pending.category_id
        ? String(pending.category_id)
        : null;

  if (!walletId) {
    throw new Error('Choisissez une poche pour valider');
  }

  const wallet = await Wallet.findOne({
    _id: walletId,
    user_id: userId,
    is_deleted: { $ne: true },
  });
  if (!wallet) throw new Error('Portefeuille introuvable');

  const balance_before = wallet.current_balance;
  let balance_after = balance_before;
  if (type === 'income') balance_after = balance_before + amount;
  else {
    balance_after = balance_before - amount;
    if (balance_after < 0) throw new Error('Solde insuffisant');
  }

  if (updates?.ai_items && updates.ai_items.length > 0) {
    // Montants inchangés : on ne remplace que les libellés par index.
    const base = pending.ai_items?.length ? pending.ai_items : updates.ai_items;
    pending.ai_items = base.map((item, idx) => ({
      description:
        updates.ai_items![idx]?.description?.trim() ||
        item.description ||
        '',
      amount: item.amount,
      quantity: item.quantity && item.quantity > 1 ? item.quantity : 1,
      unit_amount: item.unit_amount,
      type: item.type ?? type,
    }));
  }

  const line_items = (pending.ai_items || []).map((i) => ({
    description: i.description,
    amount: i.amount,
    quantity: i.quantity && i.quantity > 1 ? i.quantity : 1,
    unit_amount: i.unit_amount,
    type: i.type,
  }));

  const tx = await Transaction.create({
    user_id: userId,
    type,
    amount,
    wallet_id: walletId,
    category_id: categoryId || null,
    description,
    date: updates?.date ?? pending.date,
    balance_before,
    balance_after,
    line_items,
  });

  wallet.current_balance = balance_after;
  await wallet.save();

  pending.status = 'validated';
  pending.validated_transaction_id = tx._id;
  pending.amount = amount;
  pending.description = description;
  pending.type = type;
  pending.wallet_id = new Types.ObjectId(String(walletId));
  pending.category_id = categoryId ? new Types.ObjectId(categoryId) : null;
  await pending.save();

  if (pending.source === 'sms' || pending.source === 'notification') {
    const identity = await getUserSmsIdentity(userId);
    const reparsed = parseMobileMoneySms(pending.raw_text, identity);

    const habit = await learnFromValidation(userId, {
      counterparty: pending.counterparty || reparsed?.counterparty || description,
      pattern: pending.pattern || reparsed?.pattern || 'unknown',
      type,
      wallet_id: new Types.ObjectId(String(walletId)),
      category_id: categoryId ? new Types.ObjectId(categoryId) : null,
      description,
      sender_name: reparsed?.sender_name,
      sender_phone: reparsed?.sender_phone,
      recipient_name: reparsed?.recipient_name,
      recipient_phone: reparsed?.recipient_phone,
      userCorrections: !!updates,
    });

    try {
      await maybeSuggestRecurrence(userId, habit, amount);
    } catch (err) {
      console.warn('[RecurrenceSuggest] skipped:', err);
    }
  }

  return { pending, transactionId: tx._id };
}

export async function createFromVoiceNote(
  userId: Types.ObjectId,
  spokenText: string
): Promise<IPendingTransaction> {
  const text = spokenText.trim();
  if (!text) throw new Error('Texte vocal vide');

  const analysis = await aiService.analyzeVoiceText(text);
  if (!analysis.detected || !analysis.amount || !analysis.type) {
    throw new Error('Impossible de détecter une transaction dans la note vocale');
  }

  const warning =
    analysis.confidence < LOW_CONFIDENCE_THRESHOLD
      ? "Certaines informations n'ont pas pu être reconnues avec certitude."
      : undefined;

  return transactionDraftService.createFromVoiceAnalysis({
    userId,
    spokenText: text,
    amount: analysis.amount,
    type: analysis.type,
    description: analysis.description,
    confidence: analysis.confidence,
    date: analysis.date,
    items: analysis.items,
    warning,
  });
}

export async function countPending(userId: Types.ObjectId): Promise<number> {
  return PendingTransaction.countDocuments({ user_id: userId, status: 'pending' });
}
