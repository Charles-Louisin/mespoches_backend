import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import PlannedExpense from '../models/PlannedExpense';
import SavingsGoal from '../models/SavingsGoal';
import User from '../models/User';
import { getUtcDayStart } from '../utils/plannedExpenseDates';
import { fundingSources } from '../utils/fundingSources';
import { notifyExpoPush } from '../utils/expoPush';
import { userWallets } from './goalInsights';

/**
 * Surveille les soldes après chaque écriture :
 *  - dépense future dont la poche couvre maintenant le montant (avant l'échéance) → push « peut être réglée » ;
 *  - objectif d'épargne dont le reste est couvert par les poches → push « réalisable ».
 * Chaque alerte n'est envoyée qu'une fois ; elle se réarme si le solde redescend sous le montant.
 */

function fmt(n: number, currency: string): string {
  const v = Math.round(n).toLocaleString('fr-FR').replace(/ | /g, ' ');
  return `${v} ${currency === 'XAF' ? 'FCFA' : currency}`;
}

export async function runFundingCheck(userId: Types.ObjectId): Promise<void> {
  const tomorrow = getUtcDayStart();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  const [wallets, planned, goals] = await Promise.all([
    userWallets(userId),
    PlannedExpense.find({ user_id: userId, status: 'scheduled', scheduled_date: { $gte: tomorrow } })
      .select('wallet_id amount description funded_notified_at')
      .lean(),
    SavingsGoal.find({ user_id: userId, achieved_at: null })
      .select('title target_amount saved_amount achievable_notified_at')
      .lean(),
  ]);
  if (!planned.length && !goals.length) return;

  const balance = new Map(wallets.map((w) => [w.id, w]));
  const now = new Date();
  const newlyFunded: { id: unknown; description: string; amount: number; wallet: string }[] = [];
  const rearmPlanned: unknown[] = [];
  for (const p of planned) {
    const w = balance.get(String(p.wallet_id));
    const funded = !!w && w.balance >= p.amount;
    if (funded && !p.funded_notified_at) newlyFunded.push({ id: p._id, description: p.description, amount: p.amount, wallet: w!.name });
    if (!funded && p.funded_notified_at) rearmPlanned.push(p._id);
  }

  const readyGoals: { id: unknown; title: string; from: string }[] = [];
  const rearmGoals: unknown[] = [];
  for (const g of goals) {
    const remaining = Math.max(0, g.target_amount - (g.saved_amount ?? 0));
    const sources = fundingSources(wallets, remaining);
    const ready = remaining <= 0 || (!!sources && sources.length > 0);
    if (ready && !g.achievable_notified_at) {
      readyGoals.push({ id: g._id, title: g.title, from: (sources ?? []).map((s) => s.name).join(' + ') });
    }
    if (!ready && g.achievable_notified_at) rearmGoals.push(g._id);
  }

  await Promise.all([
    newlyFunded.length
      ? PlannedExpense.updateMany({ _id: { $in: newlyFunded.map((p) => p.id) } }, { $set: { funded_notified_at: now } })
      : null,
    rearmPlanned.length
      ? PlannedExpense.updateMany({ _id: { $in: rearmPlanned } }, { $set: { funded_notified_at: null } })
      : null,
    readyGoals.length
      ? SavingsGoal.updateMany({ _id: { $in: readyGoals.map((g) => g.id) } }, { $set: { achievable_notified_at: now } })
      : null,
    rearmGoals.length
      ? SavingsGoal.updateMany({ _id: { $in: rearmGoals } }, { $set: { achievable_notified_at: null } })
      : null,
  ]);

  if (!newlyFunded.length && !readyGoals.length) return;
  const user = await User.findById(userId).select('expoPushToken currency').lean();
  if (!user?.expoPushToken) return;
  const currency = user.currency || 'XAF';

  if (newlyFunded.length) {
    const first = newlyFunded[0];
    await notifyExpoPush({
      tokens: [user.expoPushToken],
      title: newlyFunded.length > 1 ? `${newlyFunded.length} dépenses futures peuvent être réglées` : 'Dépense future réglable',
      body:
        newlyFunded.length > 1
          ? 'Vos poches couvrent maintenant ces montants. Validez-les dans l’app quand vous voulez.'
          : `« ${first.description || 'Dépense prévue'} » (${fmt(first.amount, currency)}) : ${first.wallet} couvre le montant. Vous pouvez la valider dès maintenant.`,
      channelId: 'mes_poches_transactions',
      data: { type: 'planned-funded', screen: 'transactions', plannedId: String(first.id) },
    });
  }
  if (readyGoals.length) {
    const first = readyGoals[0];
    await notifyExpoPush({
      tokens: [user.expoPushToken],
      title: readyGoals.length > 1 ? `${readyGoals.length} objectifs réalisables` : 'Objectif réalisable',
      body:
        readyGoals.length > 1
          ? 'Vos poches couvrent maintenant ces objectifs. Ouvrez Objectifs pour voir d’où prendre l’argent.'
          : `« ${first.title} » : le montant est disponible${first.from ? ` (${first.from})` : ''}.`,
      channelId: 'mes_poches_transactions',
      data: { type: 'goal-ready', screen: 'objectifs', goalId: String(first.id) },
    });
  }
}

const timers = new Map<string, NodeJS.Timeout>();

/** Regroupe les écritures rapprochées d'un même utilisateur en une seule vérification. */
export function scheduleFundingCheck(userId: Types.ObjectId | string): void {
  const key = String(userId);
  const prev = timers.get(key);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(key);
    runFundingCheck(new Types.ObjectId(key)).catch((err) =>
      console.error('Vérification des soldes:', err instanceof Error ? err.message : err)
    );
  }, 2000);
  t.unref?.();
  timers.set(key, t);
}

const WATCHED = ['/api/transactions', '/api/pending-transactions', '/api/recurring', '/api/wallets', '/api/planned-expenses', '/api/savings-goals'];

/** Après toute écriture réussie qui peut changer un solde, on planifie la vérification. */
export function fundingWatchMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const path = (req.originalUrl || req.url || '').split('?')[0];
  if (!WATCHED.some((p) => path.startsWith(p))) return next();
  res.on('finish', () => {
    if (res.statusCode < 400 && req.user?._id) scheduleFundingCheck(req.user._id);
  });
  next();
}
