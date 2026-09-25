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
import User, { IUser } from '../models/User';
import Wallet from '../models/Wallet';

export async function revokeUserPremium(user: IUser): Promise<IUser> {
  user.plan = 'free';
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
