import { Router, Request, Response } from 'express';
import Joi from 'joi';
import SavingsGoal from '../models/SavingsGoal';
import { protect, premiumOnly } from '../middleware/auth';
import { getTotalSavings } from '../utils/savingsAllocation';

const router = Router();

const goalSchema = Joi.object({
  title: Joi.string().required(),
  target_amount: Joi.number().positive().required(),
  deadline: Joi.date().iso().allow(null),
});

const goalUpdateSchema = Joi.object({
  title: Joi.string(),
  target_amount: Joi.number().positive(),
  deadline: Joi.date().iso().allow(null),
});

router.use(protect, premiumOnly);

router.get('/total', async (req: Request, res: Response) => {
  try {
    const total = await getTotalSavings(req.user!._id);
    return res.json({ success: true, data: { total } });
  } catch (error) {
    console.error('Erreur total épargne:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors du calcul de l\'épargne totale',
    });
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const goals = await SavingsGoal.find({ user_id: req.user!._id }).sort({
      created_at: -1,
    });

    const enriched = goals.map((g) => {
      const current = g.saved_amount ?? 0;
      return {
        ...g.toObject(),
        current_amount: current,
        progress_percent:
          g.target_amount > 0
            ? Math.min(100, (current / g.target_amount) * 100)
            : 0,
      };
    });

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

    const goal = await SavingsGoal.create({
      user_id: req.user!._id,
      title: value.title,
      target_amount: value.target_amount,
      saved_amount: 0,
      deadline: value.deadline || null,
    });

    return res.status(201).json({ success: true, data: goal });
  } catch (error) {
    console.error('Erreur create goal:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la création de l\'objectif',
    });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { error, value } = goalUpdateSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const goal = await SavingsGoal.findOne({
      _id: req.params.id,
      user_id: req.user!._id,
    });
    if (!goal) {
      return res.status(404).json({
        success: false,
        message: 'Objectif introuvable',
      });
    }

    if (value.title !== undefined) goal.title = value.title;
    if (value.target_amount !== undefined) goal.target_amount = value.target_amount;
    if (value.deadline !== undefined) goal.deadline = value.deadline;

    await goal.save();

    const current = goal.saved_amount ?? 0;
    return res.json({
      success: true,
      data: {
        ...goal.toObject(),
        current_amount: current,
        progress_percent:
          goal.target_amount > 0
            ? Math.min(100, (current / goal.target_amount) * 100)
            : 0,
      },
    });
  } catch (error) {
    console.error('Erreur update goal:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour',
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
