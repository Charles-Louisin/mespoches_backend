import { Types } from 'mongoose';
import SmsHabit from '../models/SmsHabit';
import User from '../models/User';
import {
  counterpartyKey,
  ParsedMobileMoney,
  SmsPatternKind,
  UserSmsIdentity,
} from '../utils/mobileMoneySmsParser';
import { isPremiumUser } from '../utils/subscription';
import { enrichPendingWithGemini } from '../utils/geminiSmsLearning';

function normalizeName(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, ' ');
}

function normalizePhone(s: string): string {
  return s.replace(/\D/g, '').slice(-9);
}

export async function getUserSmsIdentity(userId: Types.ObjectId): Promise<UserSmsIdentity> {
  const habits = await SmsHabit.find({ user_id: userId }).select('learned_names learned_phones');
  const names = new Set<string>();
  const phones = new Set<string>();

  const user = await User.findById(userId).select('name');
  if (user?.name) names.add(normalizeName(user.name));

  for (const h of habits) {
    for (const n of h.learned_names || []) if (n) names.add(normalizeName(n));
    for (const p of h.learned_phones || []) if (p) phones.add(normalizePhone(p));
  }

  return { names: [...names], phones: [...phones] };
}

export type HabitSuggestion = {
  wallet_id: Types.ObjectId | null;
  category_id: Types.ObjectId | null;
  type?: 'income' | 'expense';
  description?: string;
  confidence: number;
  source: 'habit' | 'ai';
};

export async function suggestFromHabits(
  userId: Types.ObjectId,
  parsed: ParsedMobileMoney
): Promise<HabitSuggestion | null> {
  const key = counterpartyKey(parsed.counterparty, parsed.pattern);
  const habit = await SmsHabit.findOne({ user_id: userId, counterparty_key: key });
  if (!habit) return null;

  const boost = Math.min(0.15 * habit.validation_count, 0.45);

  return {
    wallet_id: habit.wallet_id,
    category_id: habit.category_id,
    type: habit.type,
    description: habit.description || parsed.description,
    confidence: Math.min(0.95, parsed.confidence + boost),
    source: 'habit',
  };
}

export async function applyHabitsAndAi(
  userId: Types.ObjectId,
  parsed: ParsedMobileMoney,
  rawText: string
): Promise<{
  parsed: ParsedMobileMoney;
  wallet_id: Types.ObjectId | null;
  category_id: Types.ObjectId | null;
  description: string;
  type: 'income' | 'expense';
  confidence: number;
  ai_enriched: boolean;
}> {
  const habit = await suggestFromHabits(userId, parsed);
  let type = habit?.type ?? parsed.type;
  let description = habit?.description ?? parsed.description;
  let wallet_id = habit?.wallet_id ?? null;
  let category_id = habit?.category_id ?? null;
  let confidence = habit?.confidence ?? parsed.confidence;
  let ai_enriched = false;

  const user = await User.findById(userId);
  if (user && isPremiumUser(user)) {
    try {
      const habits = await SmsHabit.find({ user_id: userId })
        .sort({ validation_count: -1 })
        .limit(40)
        .lean();

      const habitsLean = habits.map((h) => ({
        counterparty: h.counterparty,
        pattern: h.pattern,
        type: h.type,
        description: h.description,
        validation_count: h.validation_count,
        wallet_id: null as { name?: string } | null,
        category_id: null as { name?: string } | null,
      }));

      const ai = await enrichPendingWithGemini(rawText, parsed, habitsLean);
      if (ai) {
        ai_enriched = true;
        if (ai.type) type = ai.type;
        if (ai.description) description = ai.description;
        if (ai.category_hint) {
          /* category resolved below if we store category names in habits */
        }
        confidence = Math.max(confidence, ai.confidence ?? 0.85);
      }
    } catch (err) {
      console.warn('[SmsLearning] Gemini enrichment skipped:', err);
    }
  }

  return {
    parsed,
    wallet_id,
    category_id,
    type,
    description,
    confidence,
    ai_enriched,
  };
}

export async function learnFromValidation(
  userId: Types.ObjectId,
  data: {
    counterparty: string;
    pattern: SmsPatternKind;
    type: 'income' | 'expense';
    wallet_id: Types.ObjectId;
    category_id: Types.ObjectId | null;
    description: string;
    sender_name?: string;
    sender_phone?: string;
    recipient_name?: string;
    recipient_phone?: string;
    userCorrections?: boolean;
  }
): Promise<void> {
  const key = counterpartyKey(data.counterparty, data.pattern);

  const learned_names: string[] = [];
  const learned_phones: string[] = [];

  if (data.type === 'income' && data.recipient_name) {
    learned_names.push(normalizeName(data.recipient_name));
  }
  if (data.type === 'expense' && data.sender_name) {
    learned_names.push(normalizeName(data.sender_name));
  }
  if (data.recipient_phone) learned_phones.push(normalizePhone(data.recipient_phone));
  if (data.sender_phone) learned_phones.push(normalizePhone(data.sender_phone));

  await SmsHabit.findOneAndUpdate(
    { user_id: userId, counterparty_key: key },
    {
      $set: {
        counterparty: data.counterparty,
        pattern: data.pattern,
        type: data.type,
        wallet_id: data.wallet_id,
        category_id: data.category_id,
        description: data.description,
        last_validated_at: new Date(),
      },
      $inc: { validation_count: 1 },
      $addToSet: {
        learned_names: { $each: learned_names.filter(Boolean) },
        learned_phones: { $each: learned_phones.filter(Boolean) },
      },
    },
    { upsert: true, new: true }
  );
}

export async function getSmsHabitsSummary(userId: Types.ObjectId) {
  const habits = await SmsHabit.find({ user_id: userId })
    .sort({ validation_count: -1 })
    .limit(50)
    .populate('wallet_id', 'name')
    .populate('category_id', 'name');

  const identity = await getUserSmsIdentity(userId);

  return { habits, identity, total: habits.length };
}
