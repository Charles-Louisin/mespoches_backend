import { Router, Request, Response } from 'express';
import Joi from 'joi';
import PendingTransaction from '../models/PendingTransaction';
import { protect, premiumOnly } from '../middleware/auth';
import {
  createFromSms,
  createFromNotification,
  createFromAiScan,
  validatePendingTransaction,
  countPending,
} from '../services/pendingTransactionService';
import { getSmsHabitsSummary } from '../services/smsHabitService';
import { analyzeSmsRecurrences } from '../utils/geminiSmsLearning';
import { formatAiError } from '../services/ai';
import { aiScanLimiter } from '../utils/security';

const router = Router();

router.use(protect);

router.get('/', async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || 'pending';
    const list = await PendingTransaction.find({
      user_id: req.user!._id,
      status,
    })
      .populate('wallet_id')
      .populate('category_id')
      .sort({ created_at: -1 })
      .limit(100);

    res.json({ success: true, data: list });
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e instanceof Error ? e.message : 'Erreur serveur',
    });
  }
});

router.get('/count', async (req: Request, res: Response) => {
  try {
    const count = await countPending(req.user!._id);
    res.json({ success: true, data: { count } });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.get('/habits/summary', async (req: Request, res: Response) => {
  try {
    const summary = await getSmsHabitsSummary(req.user!._id);
    let recurrenceAnalysis: string | undefined;
    if (req.user && summary.habits.length >= 3) {
      try {
        const { isPremiumUser } = await import('../utils/subscription');
        if (isPremiumUser(req.user)) {
          recurrenceAnalysis = await analyzeSmsRecurrences(
            summary.habits.map((h) => ({
              counterparty: h.counterparty,
              pattern: h.pattern,
              type: h.type,
              description: h.description,
              validation_count: h.validation_count,
              wallet_id: h.wallet_id as { name?: string } | null,
              category_id: h.category_id as { name?: string } | null,
            }))
          );
        }
      } catch {
        /* IA optionnelle */
      }
    }
    res.json({
      success: true,
      data: { ...summary, recurrenceAnalysis },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const item = await PendingTransaction.findOne({
      _id: req.params.id,
      user_id: req.user!._id,
    })
      .populate('wallet_id')
      .populate('category_id');

    if (!item) {
      res.status(404).json({ success: false, message: 'Introuvable' });
      return;
    }
    res.json({ success: true, data: item });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

const updateSchema = Joi.object({
  amount: Joi.number().positive(),
  type: Joi.string().valid('income', 'expense'),
  wallet_id: Joi.string(),
  category_id: Joi.string().allow(null, ''),
  description: Joi.string().allow('', null),
  date: Joi.date().iso(),
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { error, value } = updateSchema.validate(req.body);
    if (error) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }

    const item = await PendingTransaction.findOne({
      _id: req.params.id,
      user_id: req.user!._id,
      status: 'pending',
    });
    if (!item) {
      res.status(404).json({ success: false, message: 'Introuvable' });
      return;
    }

    Object.assign(item, value);
    if (value.category_id === '' || value.category_id === null) {
      item.category_id = null;
    }
    await item.save();

    res.json({ success: true, data: item });
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e instanceof Error ? e.message : 'Erreur serveur',
    });
  }
});

router.post('/:id/validate', async (req: Request, res: Response) => {
  try {
    const item = await PendingTransaction.findOne({
      _id: req.params.id,
      user_id: req.user!._id,
    });
    if (!item) {
      res.status(404).json({ success: false, message: 'Introuvable' });
      return;
    }

    const { error, value } = updateSchema.validate(req.body);
    if (error) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }

    const result = await validatePendingTransaction(item, req.user!._id, value);
    res.json({
      success: true,
      data: {
        pending: result.pending,
        transactionId: result.transactionId,
      },
      message: 'Transaction enregistrée',
    });
  } catch (e) {
    res.status(400).json({
      success: false,
      message: e instanceof Error ? e.message : 'Validation impossible',
    });
  }
});

router.post('/:id/reject', async (req: Request, res: Response) => {
  try {
    const item = await PendingTransaction.findOneAndUpdate(
      {
        _id: req.params.id,
        user_id: req.user!._id,
        status: 'pending',
      },
      { status: 'rejected' },
      { new: true }
    );
    if (!item) {
      res.status(404).json({ success: false, message: 'Introuvable' });
      return;
    }
    res.json({ success: true, data: item, message: 'Proposition ignorée' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.post('/parse-sms', async (req: Request, res: Response) => {
  try {
    const text = String(req.body.text || '').trim();
    if (!text) {
      res.status(400).json({ success: false, message: 'Texte SMS requis' });
      return;
    }

    const created = await createFromSms(req.user!._id, text, 'sms');
    if (!created) {
      res.status(422).json({
        success: false,
        message: 'SMS non reconnu comme transaction financière',
      });
      return;
    }

    if (created.duplicate) {
      res.status(200).json({ success: true, data: created.item, duplicate: true });
      return;
    }

    res.status(201).json({ success: true, data: created.item, duplicate: false });
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e instanceof Error ? e.message : 'Erreur serveur',
    });
  }
});

router.post('/parse-notification', async (req: Request, res: Response) => {
  try {
    const title = String(req.body.title || '').trim();
    const body = String(req.body.body || '').trim();
    const packageName = req.body.packageName
      ? String(req.body.packageName).trim()
      : undefined;
    if (!title && !body) {
      res.status(400).json({ success: false, message: 'Titre ou corps requis' });
      return;
    }

    const created = await createFromNotification(
      req.user!._id,
      title,
      body,
      packageName
    );
    if (!created) {
      res.status(422).json({
        success: false,
        message: 'Notification non reconnue comme transaction financière',
      });
      return;
    }

    if (created.duplicate) {
      res.status(200).json({ success: true, data: created.item, duplicate: true });
      return;
    }

    res.status(201).json({ success: true, data: created.item, duplicate: false });
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e instanceof Error ? e.message : 'Erreur serveur',
    });
  }
});

router.post('/ai-scan', premiumOnly, aiScanLimiter, async (req: Request, res: Response) => {
  try {
    const image = String(req.body.image || '');
    const mimeType = String(req.body.mimeType || 'image/jpeg');
    if (!image) {
      res.status(400).json({ success: false, message: 'Image requise (base64)' });
      return;
    }

    const result = await createFromAiScan(req.user!._id, image, mimeType);
    res.status(201).json({
      success: true,
      data: result.items,
      warning: result.warning,
      confidence: result.confidence,
      document_type: result.document_type,
      message: `${result.items.length} transaction(s) proposée(s)`,
    });
  } catch (e) {
    res.status(400).json({
      success: false,
      message: formatAiError(e),
    });
  }
});

export default router;
