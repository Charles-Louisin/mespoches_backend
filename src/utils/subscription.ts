import Category from '../models/Category';
import { IUser, SubscriptionTier } from '../models/User';
import Wallet from '../models/Wallet';
import {
  PLAN_LIMITS,
  QUOTA_REACHED_CODE,
  TIER_DEFS,
  TRIAL_MONTHS,
  isPaidTier,
  nextTier,
  priceFor,
  type PaidTier,
} from '../config/planLimits';

export type UsageKind = 'scans' | 'voice' | 'categories' | 'wallets';

export function storedTier(user: Pick<IUser, 'subscriptionTier'>): SubscriptionTier {
  const tier = user.subscriptionTier;
  if (tier === 'pro' || tier === 'pro_plus' || tier === 'business' || tier === 'free') return tier;
  return 'free';
}

function premiumWindowOpen(user: Pick<IUser, 'plan' | 'premiumUntil'>): boolean {
  if (user.plan !== 'premium') return false;
  if (!user.premiumUntil) return true;
  return new Date(user.premiumUntil).getTime() > Date.now();
}

/** Palier réellement débloqué (essai, paiement, à vie, ou admin). */
export function accessTier(user: IUser): SubscriptionTier {
  if (user.role === 'admin') return 'business';
  const tier = storedTier(user);
  if (user.lifetime && tier !== 'free') return tier;
  if (user.lifetime && user.plan === 'premium') return tier === 'free' ? 'pro' : tier;
  if (!premiumWindowOpen(user)) return 'free';
  return tier === 'free' ? 'pro' : tier;
}

export function isPremiumUser(user: IUser): boolean {
  if (user.role === 'admin') return true;
  return accessTier(user) !== 'free';
}

export function canExportRange(user: IUser): boolean {
  return user.role === 'admin' || accessTier(user) === 'business';
}

export function exportFormatsFor(user: IUser): Array<'csv' | 'pdf' | 'xlsx'> {
  if (user.role === 'admin') return ['csv', 'pdf', 'xlsx'];
  return [...TIER_DEFS[accessTier(user)].exports];
}

/** Champs d'essai Premium 1 mois — à appliquer à la vérification email (ou Google immédiat). */
export function getNewUserTrialFields(from: Date = new Date()) {
  const premiumUntil = new Date(from);
  premiumUntil.setMonth(premiumUntil.getMonth() + TRIAL_MONTHS);
  return {
    plan: 'premium' as const,
    subscriptionTier: 'pro' as const,
    lifetime: false,
    premiumUntil,
    premiumSource: 'trial' as const,
  };
}

/**
 * Si premiumUntil est dépassé, repasse plan à free en base.
 * À appeler sur les requêtes authentifiées.
 */
export async function syncExpiredPremium(user: IUser): Promise<void> {
  if (user.role === 'admin' || user.lifetime) return;

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

function monthKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function usageCount(user: IUser, kind: 'scans' | 'voice'): number {
  if (user.usagePeriod !== monthKey()) return 0;
  return kind === 'scans' ? user.aiScansUsed || 0 : user.voiceNotesUsed || 0;
}

export function quotaPayload(
  user: IUser,
  kind: UsageKind,
  used: number
): {
  code: string;
  message: string;
  data: {
    resource: UsageKind;
    used: number;
    limit: number;
    tier: SubscriptionTier;
    tierLabel: string;
    nextTier: PaidTier | null;
    nextLabel: string | null;
    nextLimit: number | null;
    nextPriceXaf: number | null;
  };
} {
  const tier = accessTier(user);
  const limits = TIER_DEFS[tier];
  const limit =
    kind === 'categories'
      ? limits.categories
      : kind === 'wallets'
        ? limits.wallets
        : kind === 'scans'
          ? limits.scans
          : limits.voice;
  const cap = limit ?? used;
  const upcoming = nextTier(tier);
  const names: Record<UsageKind, string> = {
    categories: 'catégories',
    wallets: 'poches',
    scans: 'scans',
    voice: 'notes vocales',
  };
  const nextLimit = upcoming
    ? kind === 'categories'
      ? TIER_DEFS[upcoming].categories
      : kind === 'wallets'
        ? TIER_DEFS[upcoming].wallets
        : kind === 'scans'
          ? TIER_DEFS[upcoming].scans
          : TIER_DEFS[upcoming].voice
    : null;
  const period = kind === 'scans' || kind === 'voice' ? ' par mois' : '';
  const nextText =
    upcoming && nextLimit == null
      ? `Passez au plan ${TIER_DEFS[upcoming].label} pour un nombre illimité.`
      : upcoming
        ? `Passez au plan ${TIER_DEFS[upcoming].label} pour débloquer jusqu'à ${nextLimit}${period} !`
        : `Le quota d'usage raisonnable est de ${cap}${period}.`;
  return {
    code: QUOTA_REACHED_CODE,
    message: `Vous avez atteint votre limite de ${cap} ${names[kind]} du plan ${limits.label}. ${nextText}`,
    data: {
      resource: kind,
      used,
      limit: cap,
      tier,
      tierLabel: limits.label,
      nextTier: upcoming,
      nextLabel: upcoming ? TIER_DEFS[upcoming].label : null,
      nextLimit,
      nextPriceXaf: upcoming ? priceFor(upcoming, 'monthly') : null,
    },
  };
}

export async function buildUsage(user: IUser) {
  const tier = accessTier(user);
  const limits = TIER_DEFS[tier];
  const [categories, wallets] = await Promise.all([
    Category.countDocuments({ user_id: user._id }),
    Wallet.countDocuments({ user_id: user._id, is_deleted: { $ne: true } }),
  ]);
  const pack = (
    key: UsageKind,
    label: string,
    used: number,
    limit: number | null,
    period: 'month' | 'total'
  ) => {
    const upcoming = nextTier(tier);
    return {
      key,
      label,
      used,
      limit,
      remaining: limit == null ? null : Math.max(0, limit - used),
      period,
      nextTier: upcoming,
      nextLabel: upcoming ? TIER_DEFS[upcoming].label : null,
      nextPriceXaf: upcoming ? priceFor(upcoming, 'monthly') : null,
    };
  };
  return {
    subscriptionTier: storedTier(user),
    accessTier: tier,
    tierLabel: limits.label,
    lifetime: Boolean(user.lifetime),
    canExportRange: canExportRange(user),
    exportFormats: exportFormatsFor(user),
    quotas: {
      categories: pack('categories', 'catégories', categories, limits.categories, 'total'),
      wallets: pack('wallets', 'poches', wallets, limits.wallets, 'total'),
      scans: pack('scans', 'scans', usageCount(user, 'scans'), limits.scans, 'month'),
      voice: pack('voice', 'notes vocales', usageCount(user, 'voice'), limits.voice, 'month'),
    },
  };
}

export async function assertCapacity(
  user: IUser,
  kind: 'categories' | 'wallets',
  used: number
): Promise<ReturnType<typeof quotaPayload> | null> {
  const limits = TIER_DEFS[accessTier(user)];
  const cap = kind === 'categories' ? limits.categories : limits.wallets;
  if (cap == null || used < cap) return null;
  return quotaPayload(user, kind, used);
}

export async function assertAiQuota(
  user: IUser,
  kind: 'scans' | 'voice'
): Promise<ReturnType<typeof quotaPayload> | null> {
  const limits = TIER_DEFS[accessTier(user)];
  const cap = kind === 'scans' ? limits.scans : limits.voice;
  const used = usageCount(user, kind);
  if (used < cap) return null;
  return quotaPayload(user, kind, used);
}

export async function recordAiUsage(user: IUser, kind: 'scans' | 'voice'): Promise<void> {
  const key = monthKey();
  if (user.usagePeriod !== key) {
    user.usagePeriod = key;
    user.aiScansUsed = 0;
    user.voiceNotesUsed = 0;
  }
  if (kind === 'scans') user.aiScansUsed = (user.aiScansUsed || 0) + 1;
  else user.voiceNotesUsed = (user.voiceNotesUsed || 0) + 1;
  await user.save();
}

export function exportFormatDenied(user: IUser, format: string): ReturnType<typeof quotaPayload> | null {
  const allowed = exportFormatsFor(user);
  if (allowed.includes(format as 'csv' | 'pdf' | 'xlsx')) return null;
  const tier = accessTier(user);
  const upcoming = nextTier(tier);
  return {
    code: QUOTA_REACHED_CODE,
    message: upcoming
      ? `L'export ${format.toUpperCase()} n'est pas inclus dans le plan ${TIER_DEFS[tier].label}. Passez au plan ${TIER_DEFS[upcoming].label}.`
      : `L'export ${format.toUpperCase()} n'est pas disponible sur ce forfait.`,
    data: {
      resource: 'categories',
      used: 0,
      limit: 0,
      tier,
      tierLabel: TIER_DEFS[tier].label,
      nextTier: upcoming,
      nextLabel: upcoming ? TIER_DEFS[upcoming].label : null,
      nextLimit: null,
      nextPriceXaf: upcoming && isPaidTier(upcoming) ? priceFor(upcoming, 'monthly') : null,
    },
  };
}

export function describePlan(user: Pick<IUser, 'role' | 'plan' | 'premiumUntil' | 'premiumSource' | 'subscriptionTier' | 'lifetime' | 'suspendedAt'>): string {
  if (user.suspendedAt) return 'Suspendu';
  if (user.role === 'admin') return 'Admin';
  const tier = storedTier(user as IUser);
  const label = TIER_DEFS[tier === 'free' && user.plan === 'premium' ? 'pro' : tier].label;
  if (user.lifetime && user.plan === 'premium') return `${label} · à vie`;
  if (user.premiumSource === 'trial' && premiumWindowOpen(user)) return 'Essai Pro';
  if (premiumWindowOpen(user)) return label;
  if (tier !== 'free') return `${TIER_DEFS[tier].label} · à renouveler`;
  return 'Gratuit';
}

export function stripImageUrlIfFree<T extends { image_url?: string | null }>(
  user: IUser,
  payload: T
): T {
  if (isPremiumUser(user)) return payload;
  return { ...payload, image_url: null };
}
