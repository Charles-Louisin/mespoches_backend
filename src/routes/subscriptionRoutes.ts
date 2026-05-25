import { Router, Request, Response } from 'express';
import { protect } from '../middleware/auth';
import { SUBSCRIPTION_PLANS } from '../config/planLimits';
import { isPremiumUser } from '../utils/subscription';
import { toPublicUser } from '../utils/userPayload';

const router = Router();

router.get('/plans', (_req: Request, res: Response) => {
  return res.json({
    success: true,
    data: {
      plans: SUBSCRIPTION_PLANS,
      paymentAvailable: false,
      message:
        'Le paiement en ligne sera bientôt disponible. Vous pouvez choisir un forfait pour être redirigé vers la page de paiement.',
    },
  });
});

router.get('/status', protect, (req: Request, res: Response) => {
  return res.json({
    success: true,
    data: {
      user: toPublicUser(req.user!),
      isPremium: isPremiumUser(req.user!),
      paymentAvailable: false,
    },
  });
});

router.post('/checkout', protect, (req: Request, res: Response) => {
  const period = req.body?.period as string;
  if (period !== 'monthly' && period !== 'yearly') {
    return res.status(400).json({
      success: false,
      message: 'Forfait invalide (monthly ou yearly)',
    });
  }

  return res.status(503).json({
    success: false,
    code: 'PAYMENT_NOT_AVAILABLE',
    message:
      'Le paiement n\'est pas encore activé. Vous serez redirigé vers la page de paiement lorsque le service sera disponible.',
    data: {
      period,
      redirectPath: `/subscription/payment?period=${period}`,
    },
  });
});

export default router;
