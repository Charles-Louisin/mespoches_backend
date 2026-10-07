export const PLAN_LIMITS = {
  FREE_MAX_CATEGORIES_PER_TYPE: 5,
  FREE_HISTORY_MONTHS: 3,
} as const;

/** Essai Premium offert après vérification email (1 mois calendaire). */
export const TRIAL_MONTHS = 1;

export const PREMIUM_REQUIRED_CODE = 'PREMIUM_REQUIRED';
export const QUOTA_REACHED_CODE = 'QUOTA_REACHED';

export const SUBSCRIPTION_TIERS = ['free', 'pro', 'pro_plus', 'business'] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];
export type PaidTier = Exclude<SubscriptionTier, 'free'>;

export type ExportFormat = 'csv' | 'pdf' | 'xlsx';

type TierDef = {
  label: string;
  priceXaf: number;
  categories: number | null;
  wallets: number | null;
  scans: number;
  voice: number;
  exports: ExportFormat[];
};

export const TIER_DEFS: Record<SubscriptionTier, TierDef> = {
  free: {
    label: 'Gratuit',
    priceXaf: 0,
    categories: 5,
    wallets: 5,
    scans: 3,
    voice: 3,
    exports: [],
  },
  pro: {
    label: 'Pro',
    priceXaf: 2500,
    categories: 20,
    wallets: 20,
    scans: 30,
    voice: 30,
    exports: ['pdf'],
  },
  pro_plus: {
    label: 'Pro+',
    priceXaf: 6000,
    categories: 50,
    wallets: 50,
    scans: 100,
    voice: 100,
    exports: ['pdf', 'xlsx', 'csv'],
  },
  business: {
    label: 'Business',
    priceXaf: 20000,
    categories: null,
    wallets: null,
    scans: 500,
    voice: 500,
    exports: ['pdf', 'xlsx', 'csv'],
  },
};

/** Ancien couple mensuel / annuel : correspond au plan Pro. */
export const SUBSCRIPTION_PLANS = {
  monthly: {
    id: 'monthly' as const,
    label: 'Mensuel',
    priceXaf: TIER_DEFS.pro.priceXaf,
    periodLabel: '/ mois',
  },
  yearly: {
    id: 'yearly' as const,
    label: 'Annuel',
    priceXaf: Math.round(TIER_DEFS.pro.priceXaf * 12 * 0.8),
    periodLabel: '/ an',
    savingsLabel: 'Économisez 20 %',
  },
} as const;

export type BillingPeriod = keyof typeof SUBSCRIPTION_PLANS;

export function isSubscriptionTier(value: unknown): value is SubscriptionTier {
  return typeof value === 'string' && (SUBSCRIPTION_TIERS as readonly string[]).includes(value);
}

export function isPaidTier(value: unknown): value is PaidTier {
  return value === 'pro' || value === 'pro_plus' || value === 'business';
}

export function yearlyPrice(tier: PaidTier): number {
  return Math.round(TIER_DEFS[tier].priceXaf * 12 * 0.8);
}

export function priceFor(tier: PaidTier, period: BillingPeriod): number {
  return period === 'yearly' ? yearlyPrice(tier) : TIER_DEFS[tier].priceXaf;
}

export function nextTier(tier: SubscriptionTier): PaidTier | null {
  if (tier === 'free') return 'pro';
  if (tier === 'pro') return 'pro_plus';
  if (tier === 'pro_plus') return 'business';
  return null;
}
