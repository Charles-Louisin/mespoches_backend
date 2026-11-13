import { Types } from 'mongoose';
import SavingsGoal, { ISavingsGoal } from '../models/SavingsGoal';
import Transaction from '../models/Transaction';
import Wallet from '../models/Wallet';
import User from '../models/User';
import { fundingSources, type FundingSource, type FundingWallet } from '../utils/fundingSources';
import { aiService } from './ai';
import { isPremiumUser } from '../utils/subscription';

/** Mois AAAA-MM (UTC). */
export function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

function daysInMonth(d = new Date()): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Jours 1 à 10 → conseil de début de mois ; 4 derniers jours → bilan de fin de mois. */
export function tipPeriodFor(d = new Date()): 'start' | 'end' | null {
  const day = d.getUTCDate();
  if (day <= 10) return 'start';
  if (day >= daysInMonth(d) - 3) return 'end';
  return null;
}

export async function userWallets(userId: Types.ObjectId): Promise<FundingWallet[]> {
  const rows = await Wallet.find({ user_id: userId, is_deleted: { $ne: true } })
    .select('name current_balance')
    .lean();
  return rows.map((w) => ({ id: String(w._id), name: w.name, balance: w.current_balance || 0 }));
}

function fmt(n: number, currency: string): string {
  const v = Math.round(n).toLocaleString('fr-FR').replace(/ | /g, ' ');
  return `${v} ${currency === 'XAF' ? 'FCFA' : currency}`;
}

const MONTH_MS = 30.44 * 24 * 60 * 60 * 1000;

export type GoalTone = 'good' | 'info' | 'warn';

export type EnrichedGoal = {
  _id: string;
  title: string;
  target_amount: number;
  saved_amount: number;
  current_amount: number;
  remaining: number;
  progress_percent: number;
  deadline: Date | null;
  achieved_at: Date | null;
  created_at: Date;
  month_in: number;
  /** Le reste est couvert par les poches : l'objectif peut être réalisé maintenant. */
  achievable: boolean;
  sources: FundingSource[];
  status_message: string;
  tone: GoalTone;
  tip: { period: 'start' | 'end'; month: string; text: string } | null;
};

type GoalLike = Pick<ISavingsGoal, 'title' | 'target_amount' | 'saved_amount' | 'deadline' | 'achieved_at' | 'ai_tips' | 'created_at'> & {
  _id: unknown;
};

/** Situation de l'objectif en une phrase chiffrée. */
function statusOf(
  g: GoalLike,
  saved: number,
  monthIn: number,
  sources: FundingSource[] | null,
  currency: string,
  now: Date
): { message: string; tone: GoalTone } {
  const remaining = Math.max(0, g.target_amount - saved);
  if (g.achieved_at) return { message: 'Objectif atteint.', tone: 'good' };
  if (remaining <= 0) return { message: 'Le montant est réuni : vous pouvez le réaliser.', tone: 'good' };
  if (sources && sources.length) {
    const from = sources.map((s) => `${fmt(s.amount, currency)} de ${s.name}`).join(' + ');
    return { message: `Réalisable maintenant avec vos poches : ${from}.`, tone: 'good' };
  }
  if (g.deadline) {
    const left = new Date(g.deadline).getTime() - now.getTime();
    if (left < 0) return { message: `Échéance passée. Il manque ${fmt(remaining, currency)}.`, tone: 'warn' };
    const months = Math.max(1, Math.ceil(left / MONTH_MS));
    const perMonth = remaining / months;
    const lead = monthIn > 0 ? `+${fmt(monthIn, currency)} ce mois. ` : '';
    return {
      message: `${lead}Pour tenir l’échéance : environ ${fmt(perMonth, currency)} par mois${months > 1 ? ` pendant ${months} mois` : ''}.`,
      tone: monthIn >= perMonth ? 'good' : 'info',
    };
  }
  const pct = g.target_amount > 0 ? (saved / g.target_amount) * 100 : 0;
  if (monthIn > 0) return { message: `+${fmt(monthIn, currency)} versés ce mois. Reste ${fmt(remaining, currency)}.`, tone: 'good' };
  if (pct === 0) return { message: 'Aucun versement pour l’instant.', tone: 'info' };
  if (pct >= 75) return { message: `Plus que ${fmt(remaining, currency)}.`, tone: 'good' };
  return { message: `Aucun versement ce mois. Reste ${fmt(remaining, currency)}.`, tone: 'info' };
}

/** Versements du mois en cours par objectif (une seule agrégation). */
async function monthDeposits(userId: Types.ObjectId, goalIds: unknown[]): Promise<Map<string, number>> {
  if (!goalIds.length) return new Map();
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rows = await Transaction.aggregate<{ _id: Types.ObjectId; total: number }>([
    { $match: { user_id: userId, savings_goal_id: { $in: goalIds }, date: { $gte: start } } },
    { $group: { _id: '$savings_goal_id', total: { $sum: '$amount' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.total]));
}

export async function enrichGoals(userId: Types.ObjectId, goals: GoalLike[], currency = 'XAF'): Promise<EnrichedGoal[]> {
  const now = new Date();
  const open = goals.filter((g) => !g.achieved_at);
  const [wallets, deposits] = await Promise.all([
    open.length ? userWallets(userId) : Promise.resolve([] as FundingWallet[]),
    monthDeposits(userId, open.map((g) => g._id)),
  ]);
  const month = monthKey(now);
  return goals.map((g) => {
    const saved = g.saved_amount ?? 0;
    const remaining = Math.max(0, g.target_amount - saved);
    const sources = g.achieved_at ? [] : fundingSources(wallets, remaining);
    const monthIn = deposits.get(String(g._id)) ?? 0;
    const status = statusOf(g, saved, monthIn, remaining > 0 ? sources : [], currency, now);
    const latest = (g.ai_tips || [])
      .filter((t) => t.month === month)
      .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))[0];
    return {
      _id: String(g._id),
      title: g.title,
      target_amount: g.target_amount,
      saved_amount: saved,
      current_amount: saved,
      remaining,
      progress_percent: g.target_amount > 0 ? Math.min(100, (saved / g.target_amount) * 100) : 0,
      deadline: g.deadline,
      achieved_at: g.achieved_at ?? null,
      created_at: g.created_at,
      month_in: monthIn,
      achievable: !g.achieved_at && (remaining <= 0 || (!!sources && sources.length > 0)),
      sources: sources ?? [],
      status_message: status.message,
      tone: status.tone,
      tip: latest ? { period: latest.period, month: latest.month, text: latest.text } : null,
    };
  });
}

/* ───────────── Conseils IA : 2 par mois et par utilisateur (début, fin) ───────────── */

const inFlight = new Set<string>();

/**
 * Génère les conseils de la période en cours s'ils manquent : un seul appel IA pour tous les
 * objectifs de l'utilisateur. Sans effet hors des fenêtres début / fin de mois ou si déjà fait.
 */
export async function ensureGoalTips(userId: Types.ObjectId): Promise<void> {
  const period = tipPeriodFor();
  if (!period) return;
  const month = monthKey();
  const key = `${userId}:${month}:${period}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const goals = await SavingsGoal.find({ user_id: userId, achieved_at: null })
      .select('title target_amount saved_amount deadline ai_tips')
      .limit(10);
    const todo = goals.filter((g) => !(g.ai_tips || []).some((t) => t.month === month && t.period === period));
    if (!todo.length) return;
    const user = await User.findById(userId);
    if (!user || !isPremiumUser(user)) return;

    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [wallets, flows, topCats] = await Promise.all([
      userWallets(userId),
      Transaction.aggregate<{ _id: string; total: number }>([
        { $match: { user_id: userId, type: { $in: ['income', 'expense'] }, date: { $gte: start } } },
        { $group: { _id: '$type', total: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate<{ name: string; total: number }>([
        { $match: { user_id: userId, type: 'expense', date: { $gte: start }, category_id: { $ne: null } } },
        { $group: { _id: '$category_id', total: { $sum: '$amount' } } },
        { $sort: { total: -1 } },
        { $limit: 4 },
        { $lookup: { from: 'categories', localField: '_id', foreignField: '_id', as: 'c' } },
        { $project: { _id: 0, total: 1, name: { $ifNull: [{ $first: '$c.name' }, 'Autre'] } } },
      ]),
    ]);
    const tips = await aiService.goalTips({
      period: period === 'start' ? 'début de mois' : 'fin de mois',
      today: now.toISOString().slice(0, 10),
      currency: user.currency || 'XAF',
      monthIncome: flows.find((f) => f._id === 'income')?.total ?? 0,
      monthExpense: flows.find((f) => f._id === 'expense')?.total ?? 0,
      wallets: wallets.map((w) => ({ name: w.name, balance: w.balance })),
      topExpenseCategories: topCats,
      goals: todo.map((g) => ({
        id: String(g._id),
        title: g.title,
        target: g.target_amount,
        saved: g.saved_amount ?? 0,
        deadline: g.deadline ? g.deadline.toISOString().slice(0, 10) : null,
      })),
    });
    const byId = new Map(tips.map((t) => [t.goalId, t.text]));
    const keepFrom = monthKey(new Date(Date.now() - 62 * 86400000));
    for (const g of todo) {
      const text = byId.get(String(g._id));
      if (!text) continue;
      g.ai_tips = [...(g.ai_tips || []).filter((t) => t.month >= keepFrom), { period, month, text, created_at: new Date() }];
      await g.save();
    }
  } catch (err) {
    console.error('Conseils objectifs IA:', err instanceof Error ? err.message : err);
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Passage automatique (début et fin de mois) pour les objectifs en cours sans conseil de la période.
 * Un utilisateur à la fois : coût IA et charge maîtrisés.
 */
export async function runGoalTipsSweep(limit = 300): Promise<number> {
  const period = tipPeriodFor();
  if (!period) return 0;
  const month = monthKey();
  const userIds = await SavingsGoal.distinct('user_id', {
    achieved_at: null,
    ai_tips: { $not: { $elemMatch: { month, period } } },
  });
  let done = 0;
  for (const id of userIds.slice(0, limit)) {
    await ensureGoalTips(id as Types.ObjectId);
    done++;
  }
  return done;
}
