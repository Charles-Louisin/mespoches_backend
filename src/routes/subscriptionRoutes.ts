import { Router, Request, Response } from 'express';
import { protect } from '../middleware/auth';
import { SUBSCRIPTION_PLANS } from '../config/planLimits';
import type { BillingPeriod } from '../models/SubscriptionPayment';
import SubscriptionPayment from '../models/SubscriptionPayment';
import User from '../models/User';
import { isPremiumUser } from '../utils/subscription';
import { toPublicUser } from '../utils/userPayload';
import {
  generateTransactionId,
  initCinetPayPayment,
  isCinetPayConfigured,
} from '../utils/cinetpay';
import { getApiPublicUrl, getFrontendUrl } from '../utils/appUrl';
import { processCinetPayTransaction } from '../utils/premiumPayment';

const router = Router();

const paymentMessage = () =>
  isCinetPayConfigured()
    ? 'Paiement Mobile Money et carte disponible via CinetPay.'
    : 'Configurez CINETPAY_API_KEY et CINETPAY_SITE_ID pour activer les paiements.';

router.get('/plans', (_req: Request, res: Response) => {
  return res.json({
    success: true,
    data: {
      plans: SUBSCRIPTION_PLANS,
      paymentAvailable: isCinetPayConfigured(),
      message: paymentMessage(),
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

    const plan = SUBSCRIPTION_PLANS[period];
    const user = req.user!;
    const transactionId = generateTransactionId(user._id.toString());
    const frontendUrl = getFrontendUrl();
    const apiUrl = getApiPublicUrl();

    await SubscriptionPayment.create({
      user_id: user._id,
      transaction_id: transactionId,
      period,
      amount: plan.priceXaf,
      currency: 'XAF',
      status: 'pending',
    });

    const { paymentUrl, paymentToken } = await initCinetPayPayment({
      transactionId,
      amount: plan.priceXaf,
      description: `MES POCHES Premium — ${plan.label}`,
      notifyUrl: `${apiUrl}/api/webhooks/cinetpay`,
      returnUrl: `${frontendUrl}/subscription/payment/success?transaction_id=${encodeURIComponent(transactionId)}`,
      customer: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
      },
    });

    if (paymentToken) {
      await SubscriptionPayment.updateOne(
        { transaction_id: transactionId },
        { cinetpay_payment_token: paymentToken }
      );
    }

    return res.json({
      success: true,
      data: {
        paymentUrl,
        transactionId,
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

    return res.json({
      success: true,
      data: {
        status: result.ok ? 'completed' : result.payment.status,
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
