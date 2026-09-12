import { IUser } from '../models/User';
import { PLAN_LIMITS, TRIAL_MONTHS } from '../config/planLimits';

export function isPremiumUser(user: IUser): boolean {
  if (user.role === 'admin') return true;
  const plan = user.plan ?? 'free';
  if (plan === 'premium') {
    if (!user.premiumUntil) return true;
    return user.premiumUntil > new Date();
  }
  if (user.premiumUntil && user.premiumUntil > new Date()) {
    return true;
  }
  return false;
}

/** Champs d'essai Premium 1 mois — à appliquer à la vérification email (ou Google immédiat). */
export function getNewUserTrialFields(from: Date = new Date()) {
  const premiumUntil = new Date(from);
  premiumUntil.setMonth(premiumUntil.getMonth() + TRIAL_MONTHS);
  return {
    plan: 'premium' as const,
    premiumUntil,
    premiumSource: 'trial' as const,
  };
}

/**
 * Si premiumUntil est dépassé, repasse plan à free en base.
 * À appeler sur les requêtes authentifiées.
 */
export async function syncExpiredPremium(user: IUser): Promise<void> {
  if (user.role === 'admin') return;

  const until = user.premiumUntil ? new Date(user.premiumUntil) : null;
  const expired =
    user.plan === 'premium' && until !== null && until.getTime() <= Date.now();

  if (!expired) return;

  user.plan = 'free';
  user.premiumSource = null;
  await user.save();
}

/** Essai gratuit encore actif (Premium non payé). */
export function isOnTrial(user: IUser): boolean {
  if (user.role === 'admin') return false;
  if (user.premiumSource !== 'trial') return false;
  return isPremiumUser(user);
}

export function getFreeHistoryStartDate(): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - PLAN_LIMITS.FREE_HISTORY_MONTHS);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function applyHistoryFilterForUser(
  user: IUser,
  dateQuery: Record<string, unknown>
): Record<string, unknown> {
  if (isPremiumUser(user)) return dateQuery;
  const cutoff = getFreeHistoryStartDate();
  const existing = dateQuery.date as Record<string, Date> | undefined;
  const gte = existing?.$gte
    ? new Date(Math.max(existing.$gte.getTime(), cutoff.getTime()))
    : cutoff;
  return {
    ...dateQuery,
    date: { ...existing, $gte: gte },
  };
}

export function stripImageUrlIfFree<T extends { image_url?: string | null }>(
  user: IUser,
  payload: T
): T {
  if (isPremiumUser(user)) return payload;
  return { ...payload, image_url: null };
}
