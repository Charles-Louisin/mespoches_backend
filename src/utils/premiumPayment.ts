import User from '../models/User';
import { invalidateUserCache } from '../middleware/auth';
import SubscriptionPayment, {
  type ISubscriptionPayment,
  type BillingPeriod,
} from '../models/SubscriptionPayment';
import { getSasPayCheckoutStatus, isSasPayConfigured, verifySasPayPayment } from './saspay';

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

  // Verrou atomique : le webhook et la vérification au retour peuvent arriver en même temps,
  // un seul des deux prolonge l'abonnement.
  const claimed = await SubscriptionPayment.findOneAndUpdate(
    { _id: payment._id, status: { $ne: 'completed' } },
    { status: 'completed', completed_at: new Date() },
    { new: true }
  );
  if (!claimed) {
    const current = await User.findById(payment.user_id);
    return { activated: false, premiumUntil: current?.premiumUntil ?? null };
  }

  const user = await User.findById(payment.user_id);
  if (!user) {
    await SubscriptionPayment.findByIdAndUpdate(payment._id, { status: 'pending', completed_at: null });
    throw new Error('Utilisateur introuvable pour ce paiement');
  }

  const premiumUntil = computePremiumUntil(user.premiumUntil, payment.period);

  const tier = payment.tier === 'pro_plus' || payment.tier === 'business' ? payment.tier : 'pro';
  await User.findByIdAndUpdate(user._id, {
    plan: 'premium',
    subscriptionTier: tier,
    lifetime: false,
    premiumUntil,
    premiumSource: 'paid',
  });
  // Le middleware protect garde l'utilisateur 8 s en mémoire : le nouveau palier s'applique tout de suite.
  invalidateUserCache(String(user._id));

  return { activated: true, premiumUntil };
}

/**
 * SasPay : session de checkout → transaction → GET /payments/{id}/verify/.
 * L'accès n'est activé que si verify renvoie SUCCESS pour la transaction rattachée à NOTRE session.
 */
export async function processSasPayPayment(transactionId: string): Promise<{
  ok: boolean;
  payment?: ISubscriptionPayment;
  premiumUntil?: Date | null;
  pending?: boolean;
  failed?: boolean;
}> {
  if (!isSasPayConfigured()) return { ok: false };

  const payment = await SubscriptionPayment.findOne({ transaction_id: transactionId, provider: 'saspay' });
  if (!payment || !payment.saspay_session_id) return { ok: false, payment: payment ?? undefined };

  if (payment.status === 'completed') {
    const user = await User.findById(payment.user_id);
    return { ok: true, payment, premiumUntil: user?.premiumUntil ?? null };
  }
  if (payment.status === 'failed') return { ok: false, payment, failed: true };

  const session = await getSasPayCheckoutStatus(payment.saspay_session_id);
  const sessionStatus = String(session.status || '').toUpperCase();
  const saspayTxId = session.transaction_id || payment.saspay_transaction_id || null;

  await SubscriptionPayment.findByIdAndUpdate(payment._id, {
    saspay_status: session.transaction_status || sessionStatus,
    ...(saspayTxId ? { saspay_transaction_id: saspayTxId } : {}),
  });

  if (!saspayTxId) {
    if (sessionStatus === 'EXPIRED' || sessionStatus === 'CANCELLED') {
      await SubscriptionPayment.findByIdAndUpdate(payment._id, { status: 'failed' });
      return { ok: false, payment, failed: true };
    }
    return { ok: false, payment, pending: true };
  }

  const verified = await verifySasPayPayment(saspayTxId);
  await SubscriptionPayment.findByIdAndUpdate(payment._id, {
    saspay_status: verified.status,
    saspay_charged: verified.debited_amount ?? null,
    saspay_net_amount: verified.net_amount ?? null,
    saspay_currency: verified.currency ?? null,
  });

  if (verified.status === 'SUCCESS') {
    if (
      verified.currency === payment.currency &&
      verified.net_amount &&
      Number(verified.net_amount) < payment.amount
    ) {
      console.warn(
        `SasPay: net reçu ${verified.net_amount} < prix ${payment.amount} pour ${transactionId} — vérifiez Paramètres → Frais (ADD_ON).`
      );
    }
    const { premiumUntil } = await fulfillSubscriptionPayment(payment);
    return { ok: true, payment, premiumUntil };
  }

  // Un FAILED reste rejouable sur la page hébergée (« Réessayer ») : on ne clôt pas tant que la session est ouverte.
  if (verified.status === 'FAILED' || verified.status === 'CANCELLED') {
    if (sessionStatus === 'EXPIRED' || sessionStatus === 'CANCELLED') {
      await SubscriptionPayment.findByIdAndUpdate(payment._id, { status: 'failed' });
      return { ok: false, payment, failed: true };
    }
    return { ok: false, payment };
  }

  return { ok: false, payment, pending: true };
}
