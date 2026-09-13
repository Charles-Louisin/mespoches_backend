import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { Types } from 'mongoose';
import Wallet from '../models/Wallet';
import Transaction from '../models/Transaction';
import PlannedExpense from '../models/PlannedExpense';
import { protect, sendLimitError } from '../middleware/auth';
import {
  isPremiumUser,
  getFreeHistoryStartDate,
  stripImageUrlIfFree,
} from '../utils/subscription';
import { getTotalSavings } from '../utils/savingsAllocation';

const router = Router();

const walletSchema = Joi.object({
  name: Joi.string().required(),
  currency: Joi.string().default('XAF'),
  image_url: Joi.string().uri().allow(null, '').optional(),
  initial_balance: Joi.number().min(0).max(1_000_000_000).optional(),
});

const walletUpdateSchema = Joi.object({
  name: Joi.string().optional(),
  currency: Joi.string().optional(),
  image_url: Joi.string().uri().allow(null, '').optional(),
});

router.get('/', protect, async (req: Request, res: Response) => {
  try {
    const wallets = await Wallet.find({
      user_id: req.user!._id,
      is_deleted: { $ne: true },
    }).sort({ created_at: -1 });

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const monthAgg = await Transaction.aggregate<{
      _id: { wallet_id: Types.ObjectId; type: string };
      total: number;
    }>([
      {
        $match: {
          user_id: req.user!._id,
          type: { $in: ['income', 'expense'] },
          wallet_id: { $ne: null },
          date: { $gte: monthStart, $lte: monthEnd },
        },
      },
      {
        $group: {
          _id: { wallet_id: '$wallet_id', type: '$type' },
          total: { $sum: '$amount' },
        },
      },
    ]);

    const monthByWallet = new Map<string, { income: number; expense: number }>();
    for (const row of monthAgg) {
      const key = String(row._id.wallet_id);
      const cur = monthByWallet.get(key) || { income: 0, expense: 0 };
      if (row._id.type === 'income') cur.income = row.total;
      if (row._id.type === 'expense') cur.expense = row.total;
      monthByWallet.set(key, cur);
    }

    const data = wallets.map((w) => {
      const stats = monthByWallet.get(String(w._id)) || { income: 0, expense: 0 };
      const plain = w.toObject();
      return {
        ...plain,
        month_income: stats.income,
        month_expense: stats.expense,
      };
    });

    return res.json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error('Erreur get wallets:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des portefeuilles',
    });
  }
});

router.get('/total-balance', protect, async (req: Request, res: Response) => {
  try {
    const wallets = await Wallet.find({
      user_id: req.user!._id,
      is_deleted: { $ne: true },
    });
    const total = wallets.reduce((sum, w) => sum + w.current_balance, 0);
    const totalSavings = isPremiumUser(req.user!)
      ? await getTotalSavings(req.user!._id)
      : 0;

    return res.json({
      success: true,
      data: { total, totalSavings, wallets },
    });
  } catch (error) {
    console.error('Erreur total-balance:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors du calcul du solde total',
    });
  }
});

router.get('/:id', protect, async (req: Request, res: Response) => {
  try {
    const wallet = await Wallet.findOne({
      _id: req.params.id,
      user_id: req.user!._id,
      is_deleted: { $ne: true },
    });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Portefeuille introuvable',
      });
    }

    return res.json({ success: true, data: wallet });
  } catch (error) {
    console.error('Erreur get wallet by id:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération du portefeuille',
    });
  }
});

router.get('/:id/history', protect, async (req: Request, res: Response) => {
  try {
    const wallet = await Wallet.findOne({
      _id: req.params.id,
      user_id: req.user!._id,
      is_deleted: { $ne: true },
    });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Portefeuille introuvable',
      });
    }

    const baseQuery: Record<string, unknown> = {
      user_id: req.user!._id,
      $and: [
        {
          $or: [
            { wallet_id: req.params.id },
            { destination_wallet_id: req.params.id },
          ],
        },
        {
          $or: [
            { type: { $ne: 'transfer' } },
            { type: 'transfer', is_transfer_mirror: { $ne: true } },
          ],
        },
      ],
    };

    if (!isPremiumUser(req.user!)) {
      baseQuery.date = { $gte: getFreeHistoryStartDate() };
    }

    const transactions = await Transaction.find(baseQuery)
      .populate('wallet_id')
      .populate('destination_wallet_id')
      .populate('category_id')
      .sort({ date: -1 })
      .limit(300);

    const planned_expenses = await PlannedExpense.find({
      user_id: req.user!._id,
      wallet_id: req.params.id,
      status: 'scheduled',
    })
      .populate('wallet_id')
      .populate('category_id')
      .sort({ scheduled_date: 1, created_at: 1 });

    return res.json({
      success: true,
      data: { wallet, transactions, planned_expenses },
    });
  } catch (error) {
    console.error('Erreur wallet history:', error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération de l'historique",
    });
  }
});

router.post('/', protect, async (req: Request, res: Response) => {
  try {
    const { error, value } = walletSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const payload = stripImageUrlIfFree(req.user!, value);
    if (value.image_url && !isPremiumUser(req.user!)) {
      return sendLimitError(
        res,
        'Les images personnalisées sont réservées aux abonnés Premium.',
        { premium: true }
      );
    }

    const userCurrency = req.user!.currency || 'XAF';
    const initialBalance = Math.max(0, Number(value.initial_balance) || 0);

    const wallet = await Wallet.create({
      user_id: req.user!._id,
      name: payload.name,
      currency: userCurrency,
      image_url: payload.image_url || null,
      current_balance: initialBalance,
    });

    if (initialBalance > 0) {
      await Transaction.create({
        user_id: req.user!._id,
        type: 'income',
        amount: initialBalance,
        wallet_id: wallet._id,
        category_id: null,
        description: 'Solde initial',
        date: new Date(),
        balance_before: 0,
        balance_after: initialBalance,
      });
    }

    return res.status(201).json({
      success: true,
      data: wallet,
    });
  } catch (error) {
    console.error('Erreur create wallet:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la création du portefeuille',
    });
  }
});

router.put('/:id', protect, async (req: Request, res: Response) => {
  try {
    const { error, value } = walletUpdateSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const wallet = await Wallet.findOne({
      _id: req.params.id,
      user_id: req.user!._id,
      is_deleted: { $ne: true },
    });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Portefeuille introuvable',
      });
    }

    if (value.name) wallet.name = value.name;
    if (value.image_url !== undefined) {
      if (!isPremiumUser(req.user!) && value.image_url) {
        return sendLimitError(
          res,
          'Les images personnalisées sont réservées aux abonnés Premium.',
          { premium: true }
        );
      }
      wallet.image_url = value.image_url || null;
    }

    await wallet.save();

    return res.json({ success: true, data: wallet });
  } catch (error) {
    console.error('Erreur update wallet:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour du portefeuille',
    });
  }
});

router.delete('/:id', protect, async (req: Request, res: Response) => {
  try {
    const wallet = await Wallet.findOne({
      _id: req.params.id,
      user_id: req.user!._id,
      is_deleted: { $ne: true },
    });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Portefeuille introuvable',
      });
    }

    wallet.is_deleted = true;
    wallet.deleted_at = new Date();
    await wallet.save();

    return res.json({
      success: true,
      message: 'Portefeuille supprimé avec succès',
    });
  } catch (error) {
    console.error('Erreur delete wallet:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la suppression du portefeuille',
    });
  }
});

export default router;
