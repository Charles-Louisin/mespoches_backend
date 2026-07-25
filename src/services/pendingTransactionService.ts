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
  imageAnalysisService,
  notificationAnalysisService,
  transactionDraftService,
} from './ai';

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

    await learnFromValidation(userId, {
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
  }

  return { pending, transactionId: tx._id };
}

export async function countPending(userId: Types.ObjectId): Promise<number> {
  return PendingTransaction.countDocuments({ user_id: userId, status: 'pending' });
}
