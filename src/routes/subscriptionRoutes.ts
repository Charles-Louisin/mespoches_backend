import { Router, Request, Response } from 'express';
import { protect } from '../middleware/auth';
import {
  SUBSCRIPTION_PLANS,
  TIER_DEFS,
  TIER_RANK,
  isPaidTier,
  priceFor,
  type PaidTier,
} from '../config/planLimits';
import type { BillingPeriod } from '../models/SubscriptionPayment';
import SubscriptionPayment from '../models/SubscriptionPayment';
import User, { type IUser } from '../models/User';
import { accessTier, isPremiumUser, storedTier } from '../utils/subscription';
import { toPublicUser } from '../utils/userPayload';
import { getFrontendUrl } from '../utils/appUrl';
import { processSasPayPayment } from '../utils/premiumPayment';
import {
  createSasPayCheckoutSession,
  generateMerchantTransactionId,
  isSasPayConfigured,
  isSasPayLive,
  sasPayFeeMode,
  SasPayError,
} from '../utils/saspay';

const router = Router();

const paymentMessage = () => {
  if (!isSasPayConfigured()) return 'Le paiement en ligne n’est pas encore ouvert.';
  return isSasPayLive()
    ? 'Mobile money dans 21 pays d’Afrique ou carte bancaire internationale. Les frais de l’opérateur sont affichés et réglés sur la page de paiement.'
    : 'Mode test SasPay — aucun débit réel.';
};

/**
 * Palier PAYÉ encore actif (hors essai gratuit). Sert à refuser l'achat d'un palier inférieur :
 * on ne peut pas « redescendre » tant qu'un forfait supérieur payé court encore.
 */
export function activePaidTier(user: IUser): PaidTier | null {
  const tier = storedTier(user);
  if (!isPaidTier(tier)) return null;
  if (user.lifetime) return tier;
  if (user.premiumSource !== 'paid') return null;
  if (accessTier(user) === 'free') return null;
  return tier;
}

function downgradeBlocked(user: IUser, requested: PaidTier): PaidTier | null {
  const current = activePaidTier(user);
  if (!current) return null;
  return TIER_RANK[requested] < TIER_RANK[current] ? current : null;
}

router.get('/plans', (_req: Request, res: Response) => {
  return res.json({
    success: true,
    data: {
      plans: SUBSCRIPTION_PLANS,
      paymentAvailable: isSasPayConfigured(),
      provider: isSasPayConfigured() ? 'saspay' : null,
      feesPaidByCustomer: sasPayFeeMode() === 'ADD_ON',
      sandbox: isSasPayConfigured() ? !isSasPayLive() : false,
      message: paymentMessage(),
    },
  });
});

router.get('/status', protect, (req: Request, res: Response) => {
  const user = req.user!;
  return res.json({
    success: true,
    data: {
      user: toPublicUser(user),
      isPremium: isPremiumUser(user),
      activePaidTier: activePaidTier(user),
      paymentAvailable: isSasPayConfigured(),
    },
  });
});

/** Origine de retour fournie par le client web : acceptée seulement si elle figure dans CORS_ORIGIN / APP_URL / WEB_APP_ORIGINS (anti open-redirect). */
function allowedReturnOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let origin: string;
  try {
    origin = new URL(raw).origin;
  } catch {
    return null;
  }
  const allowed = [process.env.CORS_ORIGIN, process.env.APP_URL, process.env.WEB_APP_ORIGINS]
    .filter(Boolean)
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const isLocalDev =
    process.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return allowed.includes(origin) || isLocalDev ? origin : null;
}

router.post('/checkout', protect, async (req: Request, res: Response) => {
  if (!isSasPayConfigured()) {
    return res.status(503).json({ success: false, message: 'Le paiement en ligne n’est pas encore ouvert.' });
  }
  const period = req.body?.period as BillingPeriod;
  if (period !== 'monthly' && period !== 'yearly') {
    return res.status(400).json({ success: false, message: 'Forfait invalide (monthly ou yearly)' });
  }
  const requested = req.body?.tier;
  if (requested !== undefined && !isPaidTier(requested)) {
    return res.status(400).json({ success: false, message: 'Palier invalide' });
  }
  const tier: PaidTier = isPaidTier(requested) ? requested : 'pro';
  const user = req.user!;

  const current = downgradeBlocked(user, tier);
  if (current) {
    return res.status(409).json({
      success: false,
      code: 'DOWNGRADE_NOT_ALLOWED',
      message: `Votre forfait ${TIER_DEFS[current].label} est actif. Vous pouvez le prolonger ou passer à un forfait supérieur, pas à ${TIER_DEFS[tier].label}.`,
      data: { activeTier: current },
    });
  }

  const amount = priceFor(tier, period);
  const merchantTransactionId = generateMerchantTransactionId();
  const client = req.body?.client === 'web' ? 'web' : 'app';
  const ref = encodeURIComponent(merchantTransactionId);
  // App web (Expo web) : retour direct sur son écran de succès, si l'origine est autorisée.
  const webOrigin = client === 'web' ? allowedReturnOrigin(req.body?.return_origin) : null;
  // Sinon : page de retour du site, qui affiche le résultat puis rouvre l'app via mespoches://
  const returnUrl = webOrigin
    ? `${webOrigin}/subscription/success?transactionId=${ref}`
    : `${getFrontendUrl()}/paiement/retour?ref=${ref}&client=${client}`;

  const payment = await SubscriptionPayment.create({
    user_id: user._id,
    transaction_id: merchantTransactionId,
    provider: 'saspay',
    period,
    tier,
    amount,
    currency: 'XAF',
    status: 'pending',
  });

  try {
    const session = await createSasPayCheckoutSession({
      amount,
      currency: 'XAF',
      description: `MES POCHES ${TIER_DEFS[tier].label} — ${SUBSCRIPTION_PLANS[period].label}`,
      customerEmail: user.email,
      customerName: user.name || user.email,
      returnUrl,
      metadata: {
        merchant_transaction_id: merchantTransactionId,
        user_id: String(user._id),
        tier,
        period,
      },
    });
    await SubscriptionPayment.updateOne(
      { _id: payment._id },
      { saspay_session_id: session.id, saspay_status: session.status }
    );
    return res.json({
      success: true,
      data: { paymentUrl: session.checkout_url, transactionId: merchantTransactionId, returnUrl, provider: 'saspay' },
    });
  } catch (error) {
    await SubscriptionPayment.updateOne({ _id: payment._id }, { status: 'failed' });
    const rateLimited = error instanceof SasPayError && error.status === 429;
    console.error('Erreur checkout SasPay:', error instanceof Error ? error.message : error);
    return res.status(rateLimited ? 429 : 502).json({
      success: false,
      message: rateLimited
        ? 'Trop de tentatives, réessayez dans une minute.'
        : 'Impossible d’ouvrir la page de paiement pour le moment.',
    });
  }
});

/**
 * Page de retour web (sans session) : la référence est aléatoire (80 bits) et la réponse
 * ne contient que le statut — aucune donnée personnelle. Déclenche aussi la vérification
 * serveur, ce qui active l'abonnement même si le webhook est en retard.
 */
router.get('/return-status', async (req: Request, res: Response) => {
  const ref = String(req.query.ref || '').trim();
  if (!/^MP[a-f0-9]{20}$/.test(ref)) {
    return res.status(400).json({ success: false, message: 'Référence invalide' });
  }
  try {
    const payment = await SubscriptionPayment.findOne({ transaction_id: ref, provider: 'saspay' });
    if (!payment) return res.status(404).json({ success: false, message: 'Paiement introuvable' });
    const result = await processSasPayPayment(ref);
    const status = result.ok ? 'completed' : result.failed ? 'failed' : 'pending';
    return res.json({
      success: true,
      data: { status, tier: payment.tier, period: payment.period, amount: payment.amount, currency: payment.currency },
    });
  } catch (error) {
    console.error('Erreur return-status SasPay:', error instanceof Error ? error.message : error);
    return res.status(502).json({ success: false, message: 'Vérification momentanément indisponible' });
  }
});

router.get('/verify', protect, async (req: Request, res: Response) => {
  try {
    const transactionId = String(req.query.transaction_id || '').trim();
    if (!/^MP[a-f0-9]{20}$/.test(transactionId)) {
      return res.status(400).json({ success: false, message: 'Référence de paiement invalide' });
    }

    const payment = await SubscriptionPayment.findOne({ transaction_id: transactionId });
    // Même réponse si le paiement n'existe pas ou appartient à un autre compte (pas d'énumération).
    if (!payment || payment.user_id.toString() !== req.user!._id.toString()) {
      return res.status(404).json({ success: false, message: 'Paiement introuvable' });
    }
    if (!isSasPayConfigured()) {
      return res.status(503).json({ success: false, message: 'Paiement non configuré' });
    }

    const result = await processSasPayPayment(transactionId);
    const freshUser = await User.findById(req.user!._id);
    const me = toPublicUser(freshUser || req.user!);
    const status = result.ok ? 'completed' : result.failed ? 'failed' : 'pending';

    return res.json({
      success: true,
      data: { status, isPremium: me.isPremium, premiumUntil: me.premiumUntil, user: me },
    });
  } catch (error) {
    console.error('Erreur verify subscription:', error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: 'Erreur lors de la vérification du paiement' });
  }
});

export default router;
