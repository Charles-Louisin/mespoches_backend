import { IUser } from '../models/User';
import { isPremiumUser } from './subscription';

export function toPublicUser(user: IUser) {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    role: user.role,
    plan: user.plan,
    premiumUntil: user.premiumUntil,
    isPremium: isPremiumUser(user),
    emailVerified: user.emailVerified,
    currency: user.currency || 'XAF',
    hidePlannedExpensesHelp: !!user.hidePlannedExpensesHelp,
    created_at: user.created_at,
    lastLoginAt: user.lastLoginAt || null,
  };
}
