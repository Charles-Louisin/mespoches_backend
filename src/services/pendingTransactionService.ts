import { Types } from 'mongoose';
import PendingTransaction, { IPendingTransaction } from '../models/PendingTransaction';
import Transaction from '../models/Transaction';
import Wallet from '../models/Wallet';
import {
  extractTransactionId,
  parseMobileMoneySms,
  ParsedMobileMoney,
} from '../utils/mobileMoneySmsParser';

/**
 * Seuls les messages d'un mouvement CONFIRMÉ portent un ID de transaction (Orange Money, MTN MoMo).
 * Une demande de paiement, un code de validation ou une promo n'en ont pas : on les ignore
 * avant toute analyse (et sans appeler l'IA).
 */
export function hasTransactionId(text: string): boolean {
  return extractTransactionId(text.replace(/\s+/g, ' ')) !== '';
}
import { parseVoiceNote } from '../utils/voiceTransactionParser';
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
  moneyTextFilterService,
} from './ai';
import { LOW_CONFIDENCE_THRESHOLD } from '../config/aiModels';
import { maybeSuggestRecurrence } from './recurrenceSuggestionService';
import { resolveOwnedCategoryId } from '../utils/ownership';
import { withLineCategories } from '../utils/lineCategories';
import { catalogForPrompt, getCategoryCatalog } from '../utils/categoryCatalog';

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
  item: IPendingTransaction | null;
  duplicate: boolean;
  alreadyValidated?: boolean;
};

export async function createFromSms(
  userId: Types.ObjectId,
  text: string,
  source: 'sms' | 'notification' = 'sms'
): Promise<CreatePendingResult | null> {
  if (!hasTransactionId(text)) return null;

  const identity = await getUserSmsIdentity(userId);
  const outcome = await notificationAnalysisService.analyze(text, identity, {
    allowAi: true,
  });

  if (!outcome.parsed) return null;

  const existing = await transactionDraftService.findDuplicateMatch(
    userId,
    text,
    outcome.parsed
  );
  if (existing) {
    return { item: existing.item, duplicate: true, alreadyValidated: existing.alreadyValidated };
  }

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
  if (packageName && moneyTextFilterService.isBlockedPackage(packageName)) {
    return null;
  }

  const raw = `${title}\n${body}`.trim();
  if (!hasTransactionId(raw)) return null;

  const identity = await getUserSmsIdentity(userId);
  const outcome = await notificationAnalysisService.analyze(raw, identity, {
    packageName,
    allowAi: true,
  });

  if (!outcome.parsed) return null;

  const existing = await transactionDraftService.findDuplicateMatch(
    userId,
    raw,
    outcome.parsed
  );
  if (existing) {
    return { item: existing.item, duplicate: true, alreadyValidated: existing.alreadyValidated };
  }

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
  // Les catégories du compte guident l'IA, puis chaque bloc est rattaché à la bonne catégorie.
  const catalog = await getCategoryCatalog(userId);
  const analysis = await imageAnalysisService.analyze(base64, mimeType, catalogForPrompt(catalog));
  const items = await transactionDraftService.createFromImageAnalysis({
    userId,
    analysis,
    catalog,
  });
  if (!items.length) {
    throw new Error('Rien de lisible sur la photo. Rapprochez le ticket et réessayez.');
  }

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
      category_id?: string | null;
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
  let categoryId: string | null =
    updates?.category_id !== undefined
      ? updates.category_id
      : pending.category_id
        ? String(pending.category_id)
        : null;

  categoryId = await resolveOwnedCategoryId(userId, categoryId);

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
    // Montants inchangés : on remplace les libellés et les catégories de ligne par index.
    const base = pending.ai_items?.length ? pending.ai_items : updates.ai_items;
    const lineCats = await withLineCategories(userId, type, updates.ai_items);
    pending.ai_items = base.map((item, idx) => ({
      category_id:
        updates.ai_items![idx]?.category_id !== undefined
          ? lineCats[idx]?.category_id ?? null
          : ((item as { category_id?: Types.ObjectId | null }).category_id ?? null),
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

  // Revérifie chaque catégorie de ligne contre le type FINAL (ex. dépense passée en revenu).
  const line_items = (
    await withLineCategories(
      userId,
      type,
      // Sous-documents Mongoose → objets simples (sinon le spread ne copie pas description/amount).
      (pending.ai_items || []).map((x) => (typeof (x as { toObject?: () => unknown }).toObject === 'function' ? (x as unknown as { toObject: () => typeof x }).toObject() : x))
    )
  ).map((i) => ({
    description: i.description,
    amount: i.amount,
    quantity: i.quantity && i.quantity > 1 ? i.quantity : 1,
    unit_amount: i.unit_amount,
    type: i.type,
    category_id: i.category_id ?? null,
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

  // Apprentissage des habitudes + suggestion de récurrence (peut appeler l'IA) : en arrière-plan.
  // La transaction est déjà enregistrée ; l'utilisateur n'attend plus ces traitements.
  void learnAfterValidation(userId, pending, { type, walletId: String(walletId), categoryId, description, amount, userCorrections: !!updates }).catch(
    (err) => console.warn('[learnAfterValidation] ignoré :', err instanceof Error ? err.message : err)
  );

  return { pending, transactionId: tx._id };
}

async function learnAfterValidation(
  userId: Types.ObjectId,
  pending: IPendingTransaction,
  v: { type: 'income' | 'expense'; walletId: string; categoryId: string | null; description: string; amount: number; userCorrections: boolean }
): Promise<void> {
  const { type, walletId, categoryId, description, amount } = v;
  const User = (await import('../models/User')).default;
  const { isPremiumUser } = await import('../utils/subscription');
  const user = await User.findById(userId);
  if (user && isPremiumUser(user)) {
    const identity = await getUserSmsIdentity(userId);
    const reparsed =
      pending.source === 'sms' || pending.source === 'notification'
        ? parseMobileMoneySms(pending.raw_text, identity)
        : null;

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
      userCorrections: v.userCorrections,
    });

    try {
      await maybeSuggestRecurrence(userId, habit, amount);
    } catch (err) {
      console.warn('[RecurrenceSuggest] skipped:', err);
    }
  }
}

export async function createFromVoiceNote(
  userId: Types.ObjectId,
  spokenText: string
): Promise<IPendingTransaction[]> {
  const text = spokenText.trim();
  if (!text) throw new Error('Texte vocal vide');

  const sameVoice = await PendingTransaction.findOne({
    user_id: userId,
    raw_text: text,
    status: { $in: ['pending', 'validated'] },
  }).sort({ created_at: -1 });
  if (sameVoice) {
    if (sameVoice.status === 'validated') {
      throw new Error('Cette transaction a déjà été validée auparavant');
    }
    return [sameVoice];
  }

  const parsed = parseVoiceNote(text);
  const catalog = await getCategoryCatalog(userId);

  try {
    const analysis = await aiService.analyzeVoiceText(text, catalogForPrompt(catalog));
    if (!analysis.detected || analysis.transactions.length === 0) {
      throw new Error('Impossible de détecter une transaction dans la note vocale');
    }

    const warning =
      analysis.confidence < LOW_CONFIDENCE_THRESHOLD
        ? "Certaines informations n'ont pas pu être reconnues avec certitude."
        : undefined;

    return transactionDraftService.createFromVoiceTransactions({
      userId,
      spokenText: text,
      transactions: analysis.transactions,
      warning,
      catalog,
    });
  } catch (err) {
    if (parsed.detected && parsed.amount) {
      return transactionDraftService.createFromVoiceTransactions({
        userId,
        spokenText: text,
        fromParser: true,
        warning: "Certaines informations n'ont pas pu être reconnues avec certitude.",
        transactions: [
          {
            type: parsed.type,
            description: parsed.description,
            category_hint: parsed.category_hint,
            date: parsed.date,
            confidence: parsed.confidence,
            amount: parsed.amount,
            items: [
              {
                description: parsed.description,
                amount: parsed.amount,
                quantity: 1,
                unit_amount: parsed.amount,
                type: parsed.type,
              },
            ],
          },
        ],
      });
    }
    throw err instanceof Error
      ? err
      : new Error('Impossible de détecter une transaction dans la note vocale');
  }
}

export async function countPending(userId: Types.ObjectId): Promise<number> {
  return PendingTransaction.countDocuments({ user_id: userId, status: 'pending' });
}
