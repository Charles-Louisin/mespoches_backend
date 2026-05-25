import { Router, Request, Response } from 'express';
import Joi from 'joi';
import Wallet from '../models/Wallet';
import Transaction from '../models/Transaction';
import { protect, sendLimitError } from '../middleware/auth';
import { PLAN_LIMITS } from '../config/planLimits';
import {
  isPremiumUser,
  getFreeHistoryStartDate,
  stripImageUrlIfFree,
} from '../utils/subscription';

const router = Router();

const walletSchema = Joi.object({
  name: Joi.string().required(),
  currency: Joi.string().default('XAF'),
  image_url: Joi.string().uri().allow(null, '').optional(),
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

    return res.json({
      success: true,
      count: wallets.length,
      data: wallets,
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

    return res.json({
      success: true,
      data: { total, wallets },
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
      .sort({ date: -1 });

    return res.json({
      success: true,
      data: { wallet, transactions },
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

    const walletCount = await Wallet.countDocuments({
      user_id: req.user!._id,
      is_deleted: { $ne: true },
    });
    if (
      !isPremiumUser(req.user!) &&
      walletCount >= PLAN_LIMITS.FREE_MAX_WALLETS
    ) {
      return sendLimitError(
        res,
        `Limite atteinte : ${PLAN_LIMITS.FREE_MAX_WALLETS} poches maximum en version gratuite. Passez à Premium pour en créer davantage.`,
        { premium: true }
      );
    }

    const payload = stripImageUrlIfFree(req.user!, value);
    if (value.image_url && !isPremiumUser(req.user!)) {
      return sendLimitError(
        res,
        'Les images personnalisées sont réservées aux abonnés Premium.',
        { premium: true }
      );
    }

    const wallet = await Wallet.create({
      user_id: req.user!._id,
      name: payload.name,
      currency: payload.currency || 'XAF',
      image_url: payload.image_url || null,
      current_balance: 0,
    });

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
    if (value.currency) wallet.currency = value.currency;
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
