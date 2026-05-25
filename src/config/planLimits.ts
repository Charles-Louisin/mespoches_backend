export const PLAN_LIMITS = {
  FREE_MAX_WALLETS: 3,
  FREE_MAX_CATEGORIES_PER_TYPE: 10,
  FREE_HISTORY_MONTHS: 3,
} as const;

export const PREMIUM_REQUIRED_CODE = 'PREMIUM_REQUIRED';

export const SUBSCRIPTION_PLANS = {
  monthly: {
    id: 'monthly',
    label: 'Mensuel',
    priceXaf: 2500,
    periodLabel: '/ mois',
  },
  yearly: {
    id: 'yearly',
    label: 'Annuel',
    priceXaf: 24000,
    periodLabel: '/ an',
    savingsLabel: 'Économisez 20 %',
  },
} as const;
