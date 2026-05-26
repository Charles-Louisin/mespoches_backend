import { Router, Request, Response } from 'express';
import Joi from 'joi';
import PlannedExpense from '../models/PlannedExpense';
import Wallet from '../models/Wallet';
import { protect } from '../middleware/auth';
import {
  canUserCancelPlannedExpense,
  normalizeScheduledDate,
} from '../services/plannedExpenseService';
import { isFutureUtcDay } from '../utils/plannedExpenseDates';

const router = Router();

const plannedExpenseFields = {
  amount: Joi.number().positive().required(),
  wallet_id: Joi.string().required(),
  category_id: Joi.string().allow(null, ''),
  description: Joi.string().allow('', null),
  scheduled_date: Joi.alternatives()
    .try(Joi.date().iso(), Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/))
    .required(),
};

const createSchema = Joi.object(plannedExpenseFields);

const updateSchema = Joi.object({
  amount: Joi.number().positive().optional(),
  wallet_id: Joi.string().optional(),
  category_id: Joi.string().allow(null, '').optional(),
  description: Joi.string().allow('', null).optional(),
  scheduled_date: Joi.alternatives()
    .try(Joi.date().iso(), Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/))
    .optional(),
}).min(1);

router.get('/', protect, async (req: Request, res: Response) => {
  try {
    const { wallet_id, status } = req.query;
    const query: Record<string, unknown> = { user_id: req.user!._id };

    if (typeof wallet_id === 'string') {
      query.wallet_id = wallet_id;
    }
    if (typeof status === 'string') {
      query.status = status;
    } else {
      query.status = 'scheduled';
    }

    const items = await PlannedExpense.find(query)
      .populate('wallet_id')
      .populate('category_id')
      .sort({ scheduled_date: 1, created_at: 1 });

    return res.json({
      success: true,
      count: items.length,
      data: items,
    });
  } catch (error) {
    console.error('Erreur get planned expenses:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des dépenses prévues',
    });
  }
});

router.post('/', protect, async (req: Request, res: Response) => {
  try {
    const { error, value } = createSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const scheduledDate = normalizeScheduledDate(value.scheduled_date);

    if (!isFutureUtcDay(scheduledDate)) {
      return res.status(400).json({
        success: false,
        message:
          'La date doit être dans le futur (UTC). Pour une dépense immédiate, utilisez la date du jour.',
      });
    }

    const wallet = await Wallet.findOne({
      _id: value.wallet_id,
      user_id: req.user!._id,
      is_deleted: { $ne: true },
    });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Portefeuille introuvable',
      });
    }

    const planned = await PlannedExpense.create({
      user_id: req.user!._id,
      wallet_id: value.wallet_id,
      category_id: value.category_id || null,
      amount: value.amount,
      description: value.description || '',
      scheduled_date: scheduledDate,
      status: 'scheduled',
    });

    const populated = await PlannedExpense.findById(planned._id)
      .populate('wallet_id')
      .populate('category_id');

    return res.status(201).json({
      success: true,
      data: populated,
      message: 'Dépense future enregistrée',
    });
  } catch (error) {
    console.error('Erreur create planned expense:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la création de la dépense prévue',
    });
  }
});

router.put('/:id', protect, async (req: Request, res: Response) => {
  try {
    const { error, value } = updateSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const planned = await PlannedExpense.findOne({
      _id: req.params.id,
      user_id: req.user!._id,
    });

    if (!planned) {
      return res.status(404).json({
        success: false,
        message: 'Dépense prévue introuvable',
      });
    }

    if (planned.status !== 'scheduled') {
      return res.status(400).json({
        success: false,
        message: 'Seules les dépenses prévues actives peuvent être modifiées',
      });
    }

    if (!canUserCancelPlannedExpense(planned)) {
      return res.status(400).json({
        success: false,
        message:
          "Impossible de modifier le jour J — la dépense sera exécutée ou annulée automatiquement selon votre solde",
      });
    }

    if (value.scheduled_date !== undefined) {
      const scheduledDate = normalizeScheduledDate(value.scheduled_date);
      if (!isFutureUtcDay(scheduledDate)) {
        return res.status(400).json({
          success: false,
          message: 'La date doit être dans le futur (UTC)',
        });
      }
      planned.scheduled_date = scheduledDate;
    }

    if (value.wallet_id !== undefined) {
      const wallet = await Wallet.findOne({
        _id: value.wallet_id,
        user_id: req.user!._id,
        is_deleted: { $ne: true },
      });
      if (!wallet) {
        return res.status(404).json({
          success: false,
          message: 'Portefeuille introuvable',
        });
      }
      planned.wallet_id = value.wallet_id;
    }

    if (value.amount !== undefined) planned.amount = value.amount;
    if (value.description !== undefined) {
      planned.description = value.description || '';
    }
    if (value.category_id !== undefined) {
      planned.category_id = value.category_id || null;
    }

    await planned.save();

    const populated = await PlannedExpense.findById(planned._id)
      .populate('wallet_id')
      .populate('category_id');

    return res.json({ success: true, data: populated });
  } catch (error) {
    console.error('Erreur update planned expense:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la modification',
    });
  }
});

router.delete('/:id', protect, async (req: Request, res: Response) => {
  try {
    const planned = await PlannedExpense.findOne({
      _id: req.params.id,
      user_id: req.user!._id,
    });

    if (!planned) {
      return res.status(404).json({
        success: false,
        message: 'Dépense prévue introuvable',
      });
    }

    if (!canUserCancelPlannedExpense(planned)) {
      return res.status(400).json({
        success: false,
        message:
          planned.status !== 'scheduled'
            ? 'Cette dépense prévue ne peut plus être annulée'
            : "Impossible d'annuler le jour J — la dépense sera exécutée ou annulée automatiquement selon votre solde",
      });
    }

    planned.status = 'cancelled';
    planned.cancelled_reason = 'user';
    await planned.save();

    return res.json({
      success: true,
      message: 'Dépense prévue annulée',
    });
  } catch (error) {
    console.error('Erreur cancel planned expense:', error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de l'annulation",
    });
  }
});

export default router;
