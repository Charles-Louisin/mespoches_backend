import { Router, Request, Response } from 'express';
import SubscriptionPayment from '../models/SubscriptionPayment';
import { processCinetPayTransaction } from '../utils/premiumPayment';
import { isCinetPayConfigured } from '../utils/cinetpay';

const router = Router();

interface CinetPayNotifyBody {
  notify_token?: string;
  merchant_transaction_id?: string;
  transaction_id?: string;
}

function extractNotifyPayload(req: Request): CinetPayNotifyBody {
  const body = (req.body || {}) as CinetPayNotifyBody;
  const query = req.query as Record<string, string>;

  return {
    notify_token:
      body.notify_token ||
      query.notify_token ||
      undefined,
    merchant_transaction_id:
      body.merchant_transaction_id ||
      query.merchant_transaction_id ||
      query.cpm_trans_id ||
      query.transaction_id ||
      undefined,
    transaction_id: body.transaction_id || query.transaction_id || undefined,
  };
}

async function handleCinetPayNotification(req: Request, res: Response) {
  if (!isCinetPayConfigured()) {
    return res.status(200).json({ received: true });
  }

  const payload = extractNotifyPayload(req);
  const merchantTransactionId = payload.merchant_transaction_id?.trim();

  if (!merchantTransactionId) {
    return res.status(200).json({ received: true, skipped: 'no_merchant_transaction_id' });
  }

  const payment = await SubscriptionPayment.findOne({
    transaction_id: merchantTransactionId,
  });

  if (!payment) {
    return res.status(200).json({ received: true, skipped: 'unknown_payment' });
  }

  if (
    payload.notify_token &&
    payment.cinetpay_notify_token &&
    payload.notify_token !== payment.cinetpay_notify_token
  ) {
    console.warn(
      'Webhook CinetPay: notify_token invalide pour',
      merchantTransactionId
    );
    return res.status(403).json({ received: false, error: 'invalid_notify_token' });
  }

  if (
    payload.transaction_id &&
    payment.cinetpay_transaction_id &&
    payload.transaction_id !== payment.cinetpay_transaction_id
  ) {
    await SubscriptionPayment.updateOne(
      { _id: payment._id },
      { cinetpay_transaction_id: payload.transaction_id }
    );
  }

  try {
    await processCinetPayTransaction(merchantTransactionId);
  } catch (err) {
    console.error('Webhook CinetPay:', err);
  }

  return res.status(200).json({ received: true });
}

router.get('/cinetpay', handleCinetPayNotification);
router.post('/cinetpay', handleCinetPayNotification);

export default router;
