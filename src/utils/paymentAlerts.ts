import User from '../models/User';
import SubscriptionPayment, { type ISubscriptionPayment } from '../models/SubscriptionPayment';
import { notifyExpoPush } from './expoPush';
import { sendAdminPaymentEmail, type AdminPaymentEmail } from './email';

const TIER_LABEL: Record<string, string> = { pro: 'Pro', pro_plus: 'Pro+', business: 'Business' };

export type PaymentOutcome = 'success' | 'failed';

function money(amount: number, currency: string): string {
  const label = currency === 'XAF' ? 'FCFA' : currency;
  return `${Math.round(amount).toLocaleString('fr-FR').replace(/ | /g, ' ')} ${label}`;
}

/** Adresses qui reçoivent les alertes : comptes admin + ADMIN_ALERT_EMAILS (séparées par des virgules). */
function extraAdminEmails(): string[] {
  return (process.env.ADMIN_ALERT_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^\S+@\S+\.\S+$/.test(e));
}

/**
 * Prévient les admins du résultat d'un paiement vérifié auprès de SasPay :
 * push dans l'app (forfait, montant, résultat) et e-mail détaillé (payeur, forfait, dates).
 * Une seule alerte par résultat : succès une fois, échec une fois par transaction SasPay.
 */
export async function announcePaymentOutcome(
  payment: ISubscriptionPayment,
  outcome: PaymentOutcome,
  period?: { start: Date | null; end: Date | null }
): Promise<void> {
  const fresh = await SubscriptionPayment.findById(payment._id);
  if (!fresh) return;
  const key = outcome === 'success' ? 'success' : `failed:${fresh.saspay_transaction_id || 'session'}`;

  // Verrou atomique : webhook et retour de paiement peuvent conclure en même temps.
  const claimed = await SubscriptionPayment.findOneAndUpdate(
    { _id: fresh._id, admin_alerts: { $ne: key } },
    { $addToSet: { admin_alerts: key } },
    { new: true }
  );
  if (!claimed) return;

  const tier = TIER_LABEL[claimed.tier] ?? claimed.tier;
  const periodLabel = claimed.period === 'yearly' ? 'annuel' : 'mensuel';
  const paid = money(claimed.amount, claimed.currency);
  const ok = outcome === 'success';
  const message = ok
    ? 'Paiement réussi, forfait activé.'
    : `Paiement échoué${claimed.saspay_status ? ` (${claimed.saspay_status})` : ''}.`;

  const [payer, admins] = await Promise.all([
    User.findById(claimed.user_id)
      .select('email name plan subscriptionTier premiumUntil premiumSource created_at')
      .lean(),
    User.find({ role: 'admin' }).select('email expoPushToken').lean(),
  ]);

  const tokens = admins.map((a) => a.expoPushToken).filter((t): t is string => Boolean(t));
  const emails = [...new Set([...admins.map((a) => a.email?.toLowerCase()).filter(Boolean), ...extraAdminEmails()])] as string[];

  const push = notifyExpoPush({
    tokens,
    title: ok ? 'Paiement reçu' : 'Paiement échoué',
    body: `${tier} ${periodLabel} · ${paid} · ${message}`,
    data: { type: 'payment', status: ok ? 'completed' : 'failed' },
  });

  const details: AdminPaymentEmail = {
    success: ok,
    message,
    tier,
    periodLabel,
    amount: paid,
    charged: claimed.saspay_charged ? `${claimed.saspay_charged} ${claimed.saspay_currency || claimed.currency}` : null,
    net: claimed.saspay_net_amount ? `${claimed.saspay_net_amount} ${claimed.saspay_currency || claimed.currency}` : null,
    reference: claimed.transaction_id,
    saspayTransactionId: claimed.saspay_transaction_id ?? null,
    saspayStatus: claimed.saspay_status ?? null,
    createdAt: claimed.created_at,
    completedAt: claimed.completed_at ?? null,
    payer: payer
      ? {
          id: String(payer._id),
          name: payer.name || '',
          email: payer.email,
          memberSince: payer.created_at ?? null,
          activeTier: payer.plan === 'premium' ? TIER_LABEL[payer.subscriptionTier] ?? payer.subscriptionTier : 'Gratuit',
          source: payer.premiumSource ?? null,
          premiumUntil: payer.premiumUntil ?? null,
        }
      : null,
    periodStart: period?.start ?? null,
    periodEnd: period?.end ?? null,
  };
  const mail = Promise.all(emails.map((to) => sendAdminPaymentEmail(to, details)));

  const results = await Promise.allSettled([push, mail]);
  for (const r of results) {
    if (r.status === 'rejected') console.error('Alerte paiement admin:', r.reason);
  }
}

/** Version « tirer et oublier » : une alerte ne doit jamais bloquer l'activation du forfait. */
export function announcePaymentOutcomeSoon(
  payment: ISubscriptionPayment,
  outcome: PaymentOutcome,
  period?: { start: Date | null; end: Date | null }
): void {
  announcePaymentOutcome(payment, outcome, period).catch((err) =>
    console.error('Alerte paiement admin:', err instanceof Error ? err.message : err)
  );
}
