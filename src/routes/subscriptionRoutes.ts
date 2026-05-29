import { Router, Request, Response } from 'express';
import { protect } from '../middleware/auth';
import { SUBSCRIPTION_PLANS } from '../config/planLimits';
import type { BillingPeriod } from '../models/SubscriptionPayment';
import SubscriptionPayment from '../models/SubscriptionPayment';
import User from '../models/User';
import { isPremiumUser } from '../utils/subscription';
import { toPublicUser } from '../utils/userPayload';
import {
  generateMerchantTransactionId,
  initCinetPayPayment,
  isCinetPayConfigured,
  isCinetPayProduction,
  assertCinetPayProductionConfig,
  getCinetPaySetupPayload,
  type CinetPayPaymentMethod,
} from '../utils/cinetpay';
import { getApiPublicUrl, getFrontendUrl } from '../utils/appUrl';
import { processCinetPayTransaction } from '../utils/premiumPayment';

const router = Router();

const PAYMENT_METHODS: Record<string, CinetPayPaymentMethod> = {
  orange: 'OM_CM',
  mtn: 'MTN_CM',
  all: undefined,
};

const paymentMessage = () => {
  if (!isCinetPayConfigured()) {
    return 'Configurez CINETPAY_ACCOUNT_KEY et CINETPAY_ACCOUNT_PASSWORD pour activer les paiements.';
  }
  return isCinetPayProduction()
    ? 'Paiement réel — Orange Money, MTN MoMo et carte (Cameroun, XAF).'
    : 'Sandbox CinetPay — Orange Money, MTN MoMo et carte (Cameroun, XAF).';
};

/** IP et checklist CinetPay (à appeler sur le serveur qui exécute l’API) */
router.get('/cinetpay-setup', async (_req: Request, res: Response) => {
  const data = await getCinetPaySetupPayload();
  return res.json({ success: true, data });
});

router.get('/plans', (_req: Request, res: Response) => {
  return res.json({
    success: true,
    data: {
      plans: SUBSCRIPTION_PLANS,
      paymentAvailable: isCinetPayConfigured(),
      sandbox: !isCinetPayProduction(),
      message: paymentMessage(),
      paymentMethods: [
        { id: 'all', label: 'Tous les moyens', code: null },
        { id: 'orange', label: 'Orange Money', code: 'OM_CM' },
        { id: 'mtn', label: 'MTN MoMo', code: 'MTN_CM' },
      ],
    },
  });
});

router.get('/status', protect, (req: Request, res: Response) => {
  return res.json({
    success: true,
    data: {
      user: toPublicUser(req.user!),
      isPremium: isPremiumUser(req.user!),
      paymentAvailable: isCinetPayConfigured(),
    },
  });
});

router.post('/checkout', protect, async (req: Request, res: Response) => {
  try {
    if (!isCinetPayConfigured()) {
      return res.status(503).json({
        success: false,
        message: 'Le paiement en ligne n\'est pas encore configuré sur le serveur.',
      });
    }

    const period = req.body?.period as BillingPeriod;
    if (period !== 'monthly' && period !== 'yearly') {
      return res.status(400).json({
        success: false,
        message: 'Forfait invalide (monthly ou yearly)',
      });
    }

    const methodKey = String(req.body?.payment_method || 'all').toLowerCase();
    const paymentMethod =
      PAYMENT_METHODS[methodKey] ?? PAYMENT_METHODS.all;

    const plan = SUBSCRIPTION_PLANS[period];
    const user = req.user!;
    const merchantTransactionId = generateMerchantTransactionId();
    const frontendUrl = getFrontendUrl();
    const apiUrl = getApiPublicUrl();

    assertCinetPayProductionConfig({
      apiPublicUrl: apiUrl,
      frontendUrl,
    });

    const successUrl = `${frontendUrl}/subscription/payment/success?transaction_id=${encodeURIComponent(merchantTransactionId)}`;
    const failedUrl = `${frontendUrl}/subscription/payment?period=${period}&payment=failed`;

    await SubscriptionPayment.create({
      user_id: user._id,
      transaction_id: merchantTransactionId,
      period,
      amount: plan.priceXaf,
      currency: 'XAF',
      status: 'pending',
    });

    const init = await initCinetPayPayment({
      merchantTransactionId,
      amount: plan.priceXaf,
      description: `MES POCHES Premium — ${plan.label}`,
      notifyUrl: `${apiUrl}/api/webhooks/cinetpay`,
      successUrl,
      failedUrl,
      paymentMethod,
      customer: {
        email: user.email,
        name: user.name,
      },
    });

    await SubscriptionPayment.updateOne(
      { transaction_id: merchantTransactionId },
      {
        cinetpay_notify_token: init.notifyToken,
        cinetpay_transaction_id: init.cinetpayTransactionId || null,
      }
    );

    return res.json({
      success: true,
      data: {
        paymentUrl: init.paymentUrl,
        transactionId: merchantTransactionId,
      },
    });
  } catch (error) {
    console.error('Erreur checkout CinetPay:', error);
    const message =
      error instanceof Error ? error.message : 'Erreur lors de la création du paiement';
    return res.status(500).json({ success: false, message });
  }
});

router.get('/verify', protect, async (req: Request, res: Response) => {
  try {
    const transactionId = String(req.query.transaction_id || '').trim();
    if (!transactionId) {
      return res.status(400).json({
        success: false,
        message: 'transaction_id requis',
      });
    }

    if (!isCinetPayConfigured()) {
      return res.status(503).json({
        success: false,
        message: 'Paiement non configuré',
      });
    }

    const result = await processCinetPayTransaction(transactionId);

    if (!result.payment) {
      return res.status(404).json({
        success: false,
        message: 'Paiement introuvable',
      });
    }

    if (result.payment.user_id.toString() !== req.user!._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Ce paiement ne vous appartient pas',
      });
    }

    const freshUser = await User.findById(req.user!._id);
    const me = toPublicUser(freshUser || req.user!);

    let status: string = result.payment.status;
    if (result.ok) status = 'completed';
    else if (result.pending) status = 'pending';
    else if (result.payment.status === 'failed') status = 'failed';

    return res.json({
      success: true,
      data: {
        status,
        isPremium: me.isPremium,
        premiumUntil: me.premiumUntil,
        user: me,
      },
    });
  } catch (error) {
    console.error('Erreur verify subscription:', error);
    const message =
      error instanceof Error ? error.message : 'Erreur lors de la vérification du paiement';
    return res.status(500).json({ success: false, message });
  }
});

export default router;
