import { Router, Request, Response } from 'express';
import Joi from 'joi';
import RecurringTransaction from '../models/RecurringTransaction';
import Wallet from '../models/Wallet';
import Category from '../models/Category';
import Transaction from '../models/Transaction';
import { protect, premiumOnly } from '../middleware/auth';

const router = Router();

const recurringSchema = Joi.object({
  type: Joi.string().valid('income', 'expense').required(),
  amount: Joi.number().positive().required(),
  wallet_id: Joi.string().required(),
  category_id: Joi.string().allow(null, ''),
  description: Joi.string().allow('', null),
  frequency: Joi.string().valid('weekly', 'monthly').default('monthly'),
  day_of_month: Joi.number().min(1).max(31).allow(null),
  next_run_date: Joi.date().iso().required(),
});

router.use(protect, premiumOnly);

router.get('/', async (req: Request, res: Response) => {
  try {
    const items = await RecurringTransaction.find({ user_id: req.user!._id })
      .populate('wallet_id')
      .populate('category_id')
      .sort({ next_run_date: 1 });
    return res.json({ success: true, data: items });
  } catch (error) {
    console.error('Erreur get recurring:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des récurrences',
    });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { error, value } = recurringSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const wallet = await Wallet.findOne({
      _id: value.wallet_id,
      user_id: req.user!._id,
      is_deleted: { $ne: true },
    });
    if (!wallet) {
      return res.status(400).json({
        success: false,
        message: 'Poche introuvable',
      });
    }

    if (value.category_id) {
      const cat = await Category.findOne({
        _id: value.category_id,
        user_id: req.user!._id,
        type: value.type,
      });
      if (!cat) {
        return res.status(400).json({
          success: false,
          message: 'Catégorie invalide',
        });
      }
    }

    const item = await RecurringTransaction.create({
      user_id: req.user!._id,
      ...value,
      category_id: value.category_id || null,
      description: value.description || '',
    });

    const populated = await RecurringTransaction.findById(item._id)
      .populate('wallet_id')
      .populate('category_id');

    return res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error('Erreur create recurring:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la création',
    });
  }
});

router.post('/:id/run', async (req: Request, res: Response) => {
  try {
    const recurring = await RecurringTransaction.findOne({
      _id: req.params.id,
      user_id: req.user!._id,
      active: true,
    });
    if (!recurring) {
      return res.status(404).json({
        success: false,
        message: 'Récurrence introuvable',
      });
    }

    const wallet = await Wallet.findOne({
      _id: recurring.wallet_id,
      user_id: req.user!._id,
      is_deleted: { $ne: true },
    });
    if (!wallet) {
      return res.status(400).json({
        success: false,
        message: 'Poche introuvable',
      });
    }

    const balance_before = wallet.current_balance;
    let balance_after = balance_before;
    if (recurring.type === 'income') {
      balance_after = balance_before + recurring.amount;
    } else {
      balance_after = balance_before - recurring.amount;
      if (balance_after < 0) {
        return res.status(400).json({
          success: false,
          message: 'Solde insuffisant',
        });
      }
    }

    const transaction = await Transaction.create({
      user_id: req.user!._id,
      type: recurring.type,
      amount: recurring.amount,
      wallet_id: recurring.wallet_id,
      category_id: recurring.category_id,
      description: recurring.description || `Récurrence : ${recurring.type}`,
      date: new Date(),
      balance_before,
      balance_after,
    });

    wallet.current_balance = balance_after;
    await wallet.save();

    const next = new Date(recurring.next_run_date);
    if (recurring.frequency === 'weekly') {
      next.setDate(next.getDate() + 7);
    } else {
      next.setMonth(next.getMonth() + 1);
    }
    recurring.next_run_date = next;
    await recurring.save();

    const populated = await Transaction.findById(transaction._id)
      .populate('wallet_id')
      .populate('category_id');

    return res.json({
      success: true,
      data: { transaction: populated, recurring },
    });
  } catch (error) {
    console.error('Erreur run recurring:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'exécution',
    });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await RecurringTransaction.findOneAndDelete({
      _id: req.params.id,
      user_id: req.user!._id,
    });
    if (!result) {
      return res.status(404).json({
        success: false,
        message: 'Récurrence introuvable',
      });
    }
    return res.json({ success: true, message: 'Récurrence supprimée' });
  } catch (error) {
    console.error('Erreur delete recurring:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la suppression',
    });
  }
});

export default router;
