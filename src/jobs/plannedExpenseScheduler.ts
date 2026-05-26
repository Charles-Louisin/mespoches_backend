import User from '../models/User';
import PlannedExpense from '../models/PlannedExpense';
import { executeDuePlannedExpenses } from '../services/plannedExpenseService';
import {
  getNextUtcDay,
  getUtcDayStart,
} from '../utils/plannedExpenseDates';
import { sendPlannedExpensesReminderEmail } from '../utils/email';

const REMINDER_HOUR_UTC = Number(process.env.PLANNED_EXPENSE_REMINDER_HOUR_UTC) || 8;
const EXECUTE_HOUR_UTC = Number(process.env.PLANNED_EXPENSE_EXECUTE_HOUR_UTC) || 0;
const EXECUTE_MINUTE_UTC = Number(process.env.PLANNED_EXPENSE_EXECUTE_MINUTE_UTC) || 5;

let lastReminderDateKey: string | null = null;
let lastExecuteDateKey: string | null = null;

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function sendTomorrowReminders(): Promise<void> {
  const today = getUtcDayStart();
  const tomorrow = getNextUtcDay(today);
  const dayAfter = getNextUtcDay(tomorrow);

  const dueTomorrow = await PlannedExpense.find({
    status: 'scheduled',
    scheduled_date: { $gte: tomorrow, $lt: dayAfter },
    reminder_sent_at: null,
  })
    .populate('wallet_id')
    .populate('category_id')
    .sort({ created_at: 1 });

  if (dueTomorrow.length === 0) return;

  const byUser = new Map<string, typeof dueTomorrow>();
  for (const item of dueTomorrow) {
    const uid = String(item.user_id);
    const list = byUser.get(uid) || [];
    list.push(item);
    byUser.set(uid, list);
  }

  for (const [userId, items] of byUser) {
    const user = await User.findById(userId).select('email emailVerified name');
    if (!user?.email || !user.emailVerified) {
      for (const item of items) {
        item.reminder_sent_at = new Date();
        await item.save();
      }
      continue;
    }

    try {
      await sendPlannedExpensesReminderEmail(user.email, user.name || user.email.split('@')[0], items.map((item) => ({
        amount: item.amount,
        description: item.description,
        scheduled_date: item.scheduled_date,
        wallet_id: item.wallet_id as { name?: string } | null,
        category_id: item.category_id as { name?: string } | null,
      })));
      const now = new Date();
      for (const item of items) {
        item.reminder_sent_at = now;
        await item.save();
      }
    } catch (err) {
      console.error(`Rappel dépenses prévues — échec pour ${user.email}:`, err);
    }
  }
}

async function runDailyJobs(): Promise<void> {
  const now = new Date();
  const dateKey = utcDateKey(now);
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();

  if (
    hour === REMINDER_HOUR_UTC &&
    minute < 5 &&
    lastReminderDateKey !== dateKey
  ) {
    lastReminderDateKey = dateKey;
    try {
      await sendTomorrowReminders();
      console.log('✅ Rappels dépenses prévues (J-1) envoyés');
    } catch (err) {
      console.error('❌ Erreur rappels dépenses prévues:', err);
    }
  }

  if (
    hour === EXECUTE_HOUR_UTC &&
    minute >= EXECUTE_MINUTE_UTC &&
    minute < EXECUTE_MINUTE_UTC + 5 &&
    lastExecuteDateKey !== dateKey
  ) {
    lastExecuteDateKey = dateKey;
    try {
      const result = await executeDuePlannedExpenses();
      console.log(
        `✅ Dépenses prévues exécutées: ${result.executed} ok, ${result.cancelled} annulées (solde)`
      );
    } catch (err) {
      console.error('❌ Erreur exécution dépenses prévues:', err);
    }
  }
}

/** Vérifie chaque minute si un job quotidien UTC doit tourner. */
export function startPlannedExpenseScheduler(): void {
  const tick = () => {
    runDailyJobs().catch((err) =>
      console.error('plannedExpenseScheduler:', err)
    );
  };

  tick();
  setInterval(tick, 60 * 1000);
  console.log(
    `📅 Planificateur dépenses prévues — exécution ${String(EXECUTE_HOUR_UTC).padStart(2, '0')}:${String(EXECUTE_MINUTE_UTC).padStart(2, '0')} UTC, rappels ${REMINDER_HOUR_UTC}:00 UTC`
  );
}
