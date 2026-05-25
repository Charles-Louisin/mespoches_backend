import { Router, Request, Response } from 'express';
import Joi from 'joi';
import SavingsGoal from '../models/SavingsGoal';
import Wallet from '../models/Wallet';
import { protect, premiumOnly } from '../middleware/auth';

const router = Router();

const goalSchema = Joi.object({
  title: Joi.string().required(),
  target_amount: Joi.number().positive().required(),
  wallet_id: Joi.string().allow(null, ''),
  deadline: Joi.date().iso().allow(null),
});

router.use(protect, premiumOnly);

router.get('/', async (req: Request, res: Response) => {
  try {
    const goals = await SavingsGoal.find({ user_id: req.user!._id })
      .populate('wallet_id')
      .sort({ created_at: -1 });

    const enriched = await Promise.all(
      goals.map(async (g) => {
        let current = 0;
        if (g.wallet_id && typeof g.wallet_id === 'object' && 'current_balance' in g.wallet_id) {
          current = (g.wallet_id as { current_balance: number }).current_balance;
        } else if (g.wallet_id) {
          const w = await Wallet.findById(g.wallet_id);
          current = w?.current_balance ?? 0;
        }
        return {
          ...g.toObject(),
          current_amount: current,
          progress_percent:
            g.target_amount > 0 ? Math.min(100, (current / g.target_amount) * 100) : 0,
        };
      })
    );

    return res.json({ success: true, data: enriched });
  } catch (error) {
    console.error('Erreur get goals:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des objectifs',
    });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { error, value } = goalSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    if (value.wallet_id) {
      const w = await Wallet.findOne({
        _id: value.wallet_id,
        user_id: req.user!._id,
        is_deleted: { $ne: true },
      });
      if (!w) {
        return res.status(400).json({
          success: false,
          message: 'Poche invalide',
        });
      }
    }

    const goal = await SavingsGoal.create({
      user_id: req.user!._id,
      title: value.title,
      target_amount: value.target_amount,
      wallet_id: value.wallet_id || null,
      deadline: value.deadline || null,
    });

    const populated = await SavingsGoal.findById(goal._id).populate('wallet_id');
    return res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error('Erreur create goal:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la création de l\'objectif',
    });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await SavingsGoal.findOneAndDelete({
      _id: req.params.id,
      user_id: req.user!._id,
    });
    if (!result) {
      return res.status(404).json({
        success: false,
        message: 'Objectif introuvable',
      });
    }
    return res.json({ success: true, message: 'Objectif supprimé' });
  } catch (error) {
    console.error('Erreur delete goal:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la suppression',
    });
  }
});

export default router;
