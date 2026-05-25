import { IUser } from '../models/User';
import { PLAN_LIMITS } from '../config/planLimits';

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
