import { Types } from 'mongoose';
import PendingTransaction, { IPendingTransaction } from '../models/PendingTransaction';
import Transaction from '../models/Transaction';
import Wallet from '../models/Wallet';
import {
  parseMobileMoneySms,
  parseNotificationText,
  ParsedMobileMoney,
} from '../utils/mobileMoneySmsParser';
import { parseReceiptImage, AiReceiptItem } from '../utils/gemini';
import {
  applyHabitsAndAi,
  getUserSmsIdentity,
  learnFromValidation,
} from './smsHabitService';

async function getDefaultWalletId(userId: Types.ObjectId): Promise<Types.ObjectId | null> {
  const w = await Wallet.findOne({ user_id: userId, is_deleted: { $ne: true } }).sort({
    created_at: 1,
  });
  return w?._id ?? null;
}

async function findDuplicate(
  userId: Types.ObjectId,
  text: string,
  transactionId: string
): Promise<IPendingTransaction | null> {
  if (transactionId) {
    const byTx = await PendingTransaction.findOne({
      user_id: userId,
      status: 'pending',
      transaction_id: transactionId,
    });
    if (byTx) return byTx;
  }
  return PendingTransaction.findOne({
    user_id: userId,
    status: 'pending',
    raw_text: text.trim(),
  });
}

async function buildFromParsed(
  userId: Types.ObjectId,
  parsed: ParsedMobileMoney,
  rawText: string,
  source: 'sms' | 'notification'
): Promise<IPendingTransaction> {
  const enriched = await applyHabitsAndAi(userId, parsed, rawText);
  const wallet_id =
    enriched.wallet_id ?? (await getDefaultWalletId(userId));

  return PendingTransaction.create({
    user_id: userId,
    status: 'pending',
    source,
    type: enriched.type,
    amount: parsed.amount,
    operator: parsed.operator,
    counterparty: parsed.counterparty,
    description: enriched.description,
    date: parsed.date,
    raw_text: rawText.trim(),
    wallet_id,
    category_id: enriched.category_id,
    confidence: enriched.confidence,
    pattern: parsed.pattern,
    transaction_id: parsed.transaction_id,
    ai_enriched: enriched.ai_enriched,
  });
}

export async function createFromSms(
  userId: Types.ObjectId,
  text: string,
  source: 'sms' | 'notification' = 'sms'
): Promise<IPendingTransaction | null> {
  const identity = await getUserSmsIdentity(userId);
  const parsed = parseMobileMoneySms(text, identity);
  if (!parsed) return null;

  const existing = await findDuplicate(userId, text, parsed.transaction_id);
  if (existing) return existing;

  return buildFromParsed(userId, parsed, text, source);
}

export async function createFromNotification(
  userId: Types.ObjectId,
  title: string,
  body: string
): Promise<IPendingTransaction | null> {
  const identity = await getUserSmsIdentity(userId);
  const parsed = parseNotificationText(title, body, identity);
  if (!parsed) return null;

  const raw = `${title}\n${body}`.trim();
  const existing = await findDuplicate(userId, raw, parsed.transaction_id);
  if (existing) return existing;

  return buildFromParsed(userId, parsed, raw, 'notification');
}

export async function createFromAiScan(
  userId: Types.ObjectId,
  base64: string,
  mimeType: string
): Promise<IPendingTransaction[]> {
  const result = await parseReceiptImage(base64, mimeType);
  const wallet_id = await getDefaultWalletId(userId);
  const created: IPendingTransaction[] = [];

  for (const item of result.items) {
    const doc = await PendingTransaction.create({
      user_id: userId,
      status: 'pending',
      source: 'ai_scan',
      type: item.type,
      amount: item.amount,
      operator: 'unknown',
      counterparty: '',
      description: item.description,
      date: item.date ? new Date(item.date) : new Date(),
      raw_text: result.rawSummary,
      wallet_id,
      confidence: 0.75,
      pattern: 'unknown',
      ai_enriched: true,
      ai_items: result.items as AiReceiptItem[],
    });
    created.push(doc);
  }

  return created;
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
