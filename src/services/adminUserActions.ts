import { invalidateUserCache } from '../middleware/auth';
import AnalyticsEvent from '../models/AnalyticsEvent';
import Budget from '../models/Budget';
import Category from '../models/Category';
import FeedbackMessage from '../models/FeedbackMessage';
import PendingTransaction from '../models/PendingTransaction';
import PlannedExpense from '../models/PlannedExpense';
import RecurringTransaction from '../models/RecurringTransaction';
import SavingsGoal from '../models/SavingsGoal';
import SmsHabit from '../models/SmsHabit';
import SubscriptionPayment from '../models/SubscriptionPayment';
import Transaction from '../models/Transaction';
import User, { IUser, SubscriptionTier } from '../models/User';
import { isSubscriptionTier } from '../config/planLimits';
import Wallet from '../models/Wallet';

export async function revokeUserPremium(user: IUser): Promise<IUser> {
  user.plan = 'free';
  user.subscriptionTier = 'free';
  user.lifetime = false;
  user.premiumUntil = null;
  user.premiumSource = null;
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();
  await SubscriptionPayment.updateMany(
    { user_id: user._id, status: 'pending' },
    { $set: { status: 'failed', cinetpay_status: 'admin_revoked' } }
  );
  invalidateUserCache(user._id.toString());
  return user;
}

export async function setUserSubscription(
  user: IUser,
  tier: SubscriptionTier,
  lifetime: boolean
): Promise<IUser> {
  if (!isSubscriptionTier(tier) || tier === 'free') {
    return revokeUserPremium(user);
  }
  user.subscriptionTier = tier;
  user.plan = 'premium';
  user.lifetime = lifetime;
  if (lifetime) {
    user.premiumUntil = null;
    user.premiumSource = 'lifetime';
  } else {
    const until = new Date();
    until.setMonth(until.getMonth() + 1);
    user.premiumUntil = until;
    user.premiumSource = 'paid';
  }
  await user.save();
  invalidateUserCache(user._id.toString());
  return user;
}

/** Retire le forfait à vie : le palier est mémorisé, l'accès s'arrête jusqu'au prochain paiement. */
export async function resumeUserBilling(user: IUser): Promise<IUser> {
  user.lifetime = false;
  user.plan = 'free';
  user.premiumUntil = null;
  if (user.premiumSource === 'lifetime') user.premiumSource = null;
  await user.save();
  invalidateUserCache(user._id.toString());
  return user;
}

export async function setUserSuspended(user: IUser, suspended: boolean): Promise<IUser> {
  user.suspendedAt = suspended ? new Date() : null;
  if (suspended) {
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  }
  await user.save();
  invalidateUserCache(user._id.toString());
  return user;
}

export async function purgeUserAccount(userId: string): Promise<void> {
  await Promise.all([
    Wallet.deleteMany({ user_id: userId }),
    Transaction.deleteMany({ user_id: userId }),
    Category.deleteMany({ user_id: userId }),
    Budget.deleteMany({ user_id: userId }),
    SavingsGoal.deleteMany({ user_id: userId }),
    RecurringTransaction.deleteMany({ user_id: userId }),
    PlannedExpense.deleteMany({ user_id: userId }),
    PendingTransaction.deleteMany({ user_id: userId }),
    SmsHabit.deleteMany({ user_id: userId }),
    SubscriptionPayment.deleteMany({ user_id: userId }),
    FeedbackMessage.deleteMany({ user_id: userId }),
    AnalyticsEvent.deleteMany({ user_id: userId }),
  ]);
  await User.deleteOne({ _id: userId });
  invalidateUserCache(userId);
}
