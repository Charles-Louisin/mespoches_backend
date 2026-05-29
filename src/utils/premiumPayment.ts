import User from '../models/User';
import SubscriptionPayment, {
  type ISubscriptionPayment,
  type BillingPeriod,
} from '../models/SubscriptionPayment';
import {
  getCinetPayPaymentStatus,
  isCinetPayConfigured,
  isCinetPayPaymentFailed,
  isCinetPayPaymentSuccess,
} from './cinetpay';

export function computePremiumUntil(
  currentUntil: Date | null | undefined,
  period: BillingPeriod
): Date {
  const now = new Date();
  let base = now;
  if (currentUntil && currentUntil > now) {
    base = currentUntil;
  }
  const result = new Date(base);
  if (period === 'monthly') {
    result.setMonth(result.getMonth() + 1);
  } else {
    result.setFullYear(result.getFullYear() + 1);
  }
  return result;
}

export async function fulfillSubscriptionPayment(
  payment: ISubscriptionPayment
): Promise<{ activated: boolean; premiumUntil: Date | null }> {
  if (payment.status === 'completed') {
    const user = await User.findById(payment.user_id);
    return {
      activated: false,
      premiumUntil: user?.premiumUntil ?? null,
    };
  }

  const user = await User.findById(payment.user_id);
  if (!user) {
    throw new Error('Utilisateur introuvable pour ce paiement');
  }

  const premiumUntil = computePremiumUntil(user.premiumUntil, payment.period);

  await User.findByIdAndUpdate(user._id, {
    plan: 'premium',
    premiumUntil,
  });

  await SubscriptionPayment.findByIdAndUpdate(payment._id, {
    status: 'completed',
    completed_at: new Date(),
  });

  return { activated: true, premiumUntil };
}

export async function processCinetPayTransaction(transactionId: string): Promise<{
  ok: boolean;
  payment?: ISubscriptionPayment;
  premiumUntil?: Date | null;
  pending?: boolean;
}> {
  if (!isCinetPayConfigured()) {
    return { ok: false };
  }

  const payment = await SubscriptionPayment.findOne({ transaction_id: transactionId });
  if (!payment) {
    return { ok: false };
  }

  if (payment.status === 'completed') {
    const user = await User.findById(payment.user_id);
    return { ok: true, payment, premiumUntil: user?.premiumUntil ?? null };
  }

  if (payment.status === 'failed') {
    return { ok: false, payment };
  }

  const status = await getCinetPayPaymentStatus(transactionId);

  await SubscriptionPayment.findByIdAndUpdate(payment._id, {
    cinetpay_status: status.status,
    ...(status.transaction_id
      ? { cinetpay_transaction_id: status.transaction_id }
      : {}),
  });

  if (isCinetPayPaymentSuccess(status)) {
    const { premiumUntil } = await fulfillSubscriptionPayment(payment);
    return { ok: true, payment, premiumUntil };
  }

  if (isCinetPayPaymentFailed(status)) {
    await SubscriptionPayment.findByIdAndUpdate(payment._id, {
      status: 'failed',
    });
    return { ok: false, payment };
  }

  return { ok: false, payment, pending: true };
}
