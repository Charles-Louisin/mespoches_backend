import { Types } from 'mongoose';
import RecurringTransaction from '../models/RecurringTransaction';
import type { ISmsHabit } from '../models/SmsHabit';

const MIN_VALIDATIONS = 3;

/**
 * Après plusieurs validations similaires, propose une récurrence
 * en attente de confirmation utilisateur (status suggested).
 */
export async function maybeSuggestRecurrence(
  userId: Types.ObjectId,
  habit: ISmsHabit | null | undefined,
  amount: number
): Promise<void> {
  if (!habit || habit.validation_count < MIN_VALIDATIONS) return;
  if (!habit.wallet_id) return;

  const existing = await RecurringTransaction.findOne({
    user_id: userId,
    description: habit.description,
    type: habit.type,
    $or: [{ status: 'suggested' }, { status: 'active', active: true }],
  });
  if (existing) return;

  const next = new Date();
  next.setMonth(next.getMonth() + 1);
  if (habit.last_validated_at) {
    const d = new Date(habit.last_validated_at);
    next.setDate(Math.min(28, d.getDate()));
  }

  await RecurringTransaction.create({
    user_id: userId,
    type: habit.type,
    amount,
    wallet_id: habit.wallet_id,
    category_id: habit.category_id,
    description: habit.description || habit.counterparty || 'Paiement récurrent',
    frequency: 'monthly',
    day_of_month: next.getDate(),
    next_run_date: next,
    active: false,
    status: 'suggested',
    source: 'ai',
  });
}
