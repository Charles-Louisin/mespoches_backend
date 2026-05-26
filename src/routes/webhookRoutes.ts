import { Router, Request, Response } from 'express';
import { processCinetPayTransaction } from '../utils/premiumPayment';
import { isCinetPayConfigured } from '../utils/cinetpay';

const router = Router();

function extractTransactionId(req: Request): string | null {
  const fromQuery =
    (req.query.cpm_trans_id as string) ||
    (req.query.transaction_id as string);

  if (fromQuery?.trim()) return fromQuery.trim();

  const body = req.body as Record<string, unknown>;
  for (const key of ['cpm_trans_id', 'transaction_id', 'trans_id']) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  return null;
}

async function handleCinetPayNotification(req: Request, res: Response) {
  if (!isCinetPayConfigured()) {
    return res.status(200).json({ received: true });
  }

  const transactionId = extractTransactionId(req);
  if (transactionId) {
    try {
      await processCinetPayTransaction(transactionId);
    } catch (err) {
      console.error('Webhook CinetPay:', err);
    }
  }

  return res.status(200).json({ received: true });
}

router.get('/cinetpay', handleCinetPayNotification);
router.post('/cinetpay', handleCinetPayNotification);

export default router;
