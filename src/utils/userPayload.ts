import { IUser } from '../models/User';
import { accessTier, isOnTrial, isPremiumUser, storedTier } from './subscription';

export function toPublicUser(user: IUser) {
  const premium = isPremiumUser(user);
  const onTrial = isOnTrial(user);
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    role: user.role,
    plan: user.plan,
    subscriptionTier: storedTier(user),
    accessTier: accessTier(user),
    lifetime: Boolean(user.lifetime),
    premiumUntil: user.premiumUntil,
    premiumSource: user.premiumSource ?? null,
    isPremium: premium,
    isOnTrial: onTrial,
    emailVerified: user.emailVerified,
    currency: user.currency || 'XAF',
    hidePlannedExpensesHelp: !!user.hidePlannedExpensesHelp,
    created_at: user.created_at,
    lastLoginAt: user.lastLoginAt || null,
    suspended: Boolean(user.suspendedAt),
  };
}
