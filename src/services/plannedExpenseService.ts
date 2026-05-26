import { Types } from 'mongoose';
import PlannedExpense, { IPlannedExpense } from '../models/PlannedExpense';
import Wallet from '../models/Wallet';
import { getUtcDayStart, parseToUtcDay } from '../utils/plannedExpenseDates';
import { createExpenseTransaction } from './walletTransaction';

export async function executePlannedExpense(
  planned: IPlannedExpense
): Promise<'executed' | 'cancelled'> {
  if (planned.status !== 'scheduled') {
    return planned.status === 'executed' ? 'executed' : 'cancelled';
  }

  const wallet = await Wallet.findOne({
    _id: planned.wallet_id,
    user_id: planned.user_id,
    is_deleted: { $ne: true },
  });

  if (!wallet) {
    planned.status = 'cancelled';
    planned.cancelled_reason = 'insufficient_balance';
    await planned.save();
    return 'cancelled';
  }

  if (wallet.current_balance < planned.amount) {
    planned.status = 'cancelled';
    planned.cancelled_reason = 'insufficient_balance';
    await planned.save();
    return 'cancelled';
  }

  const transaction = await createExpenseTransaction({
    userId: planned.user_id as Types.ObjectId,
    data: {
      amount: planned.amount,
      wallet_id: String(planned.wallet_id),
      category_id: planned.category_id ? String(planned.category_id) : null,
      description: planned.description,
      date: planned.scheduled_date,
    },
  });

  planned.status = 'executed';
  planned.executed_transaction_id = transaction._id as Types.ObjectId;
  planned.cancelled_reason = null;
  await planned.save();

  return 'executed';
}

/** Exécute toutes les dépenses prévues pour le jour UTC courant. */
export async function executeDuePlannedExpenses(): Promise<{
  executed: number;
  cancelled: number;
}> {
  const today = getUtcDayStart();
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  const due = await PlannedExpense.find({
    status: 'scheduled',
    scheduled_date: { $gte: today, $lt: tomorrow },
  }).sort({ created_at: 1 });

  let executed = 0;
  let cancelled = 0;

  for (const planned of due) {
    const result = await executePlannedExpense(planned);
    if (result === 'executed') executed++;
    else cancelled++;
  }

  return { executed, cancelled };
}

export function canUserCancelPlannedExpense(planned: IPlannedExpense): boolean {
  if (planned.status !== 'scheduled') return false;
  const today = getUtcDayStart();
  return planned.scheduled_date.getTime() > today.getTime();
}

export function normalizeScheduledDate(dateInput: string | Date): Date {
  return parseToUtcDay(dateInput);
}
