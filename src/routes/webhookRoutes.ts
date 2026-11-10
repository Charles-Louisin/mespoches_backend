import { Router, Request, Response } from 'express';
import SubscriptionPayment from '../models/SubscriptionPayment';
import { processSasPayPayment } from '../utils/premiumPayment';
import { isValidSasPayWebhook } from '../utils/saspay';
import { webhookLimiter } from '../utils/security';

const router = Router();

/* ───────────────────────────── SasPay ───────────────────────────── */

interface SasPayWebhookBody {
  event?: string;
  data?: {
    id?: string;
    status?: string;
    metadata?: Record<string, unknown>;
    checkout_session?: string;
  };
}

/** Retrouve notre paiement : par id de transaction SasPay, par metadata, sinon via le statut des sessions récentes. */
async function settleSasPayEvent(body: SasPayWebhookBody): Promise<void> {
  const txId = body.data?.id ? String(body.data.id) : '';
  const metaRef = body.data?.metadata?.merchant_transaction_id;

  const direct =
    (typeof metaRef === 'string' &&
      (await SubscriptionPayment.findOne({ transaction_id: metaRef, provider: 'saspay' }))) ||
    (txId && (await SubscriptionPayment.findOne({ saspay_transaction_id: txId, provider: 'saspay' })));
  if (direct) {
    await processSasPayPayment(direct.transaction_id);
    return;
  }

  // Le payload transaction.* ne référence pas la session : on revérifie les sessions encore ouvertes.
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const candidates = await SubscriptionPayment.find({
    provider: 'saspay',
    status: 'pending',
    saspay_session_id: { $ne: null },
    created_at: { $gte: since },
  })
    .sort({ created_at: -1 })
    .limit(15);
  for (const candidate of candidates) {
    const result = await processSasPayPayment(candidate.transaction_id);
    const fresh = await SubscriptionPayment.findById(candidate._id).select('saspay_transaction_id');
    if (result.ok || (txId && fresh?.saspay_transaction_id === txId)) return;
  }
}

router.post('/saspay', webhookLimiter, async (req: Request, res: Response) => {
  const secret = process.env.SASPAY_WEBHOOK_SECRET?.trim() || '';
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!secret) {
    console.warn('Webhook SasPay reçu mais SASPAY_WEBHOOK_SECRET absent');
    return res.status(503).json({ received: false, error: 'not_configured' });
  }
  if (
    !raw ||
    !isValidSasPayWebhook(
      raw,
      req.header('x-webhook-signature') || undefined,
      req.header('x-webhook-timestamp') || undefined,
      secret
    )
  ) {
    return res.status(401).json({ received: false, error: 'invalid_signature' });
  }

  const body = (req.body || {}) as SasPayWebhookBody;
  const event = body.event || req.header('x-webhook-event') || '';
  // Réponse immédiate (SasPay coupe à 15 s) ; la vérification serveur suit.
  res.status(200).json({ received: true });

  if (event === 'transaction.success' || event === 'transaction.failed' || event === 'transaction.cancelled') {
    settleSasPayEvent(body).catch((err) => console.error('Webhook SasPay:', err));
  }
});

export default router;
