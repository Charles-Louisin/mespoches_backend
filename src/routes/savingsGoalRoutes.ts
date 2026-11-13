import { Router, Request, Response } from 'express';
import Joi from 'joi';
import SavingsGoal from '../models/SavingsGoal';
import { protect, premiumOnly } from '../middleware/auth';
import { getTotalSavings } from '../utils/savingsAllocation';
import { enrichGoals, ensureGoalTips } from '../services/goalInsights';

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
    // ?status=achieved → historique des objectifs atteints ; par défaut, les objectifs en cours.
    const achieved = req.query.status === 'achieved';
    const goals = await SavingsGoal.find({
      user_id: req.user!._id,
      achieved_at: achieved ? { $ne: null } : null,
    })
      .select('title target_amount saved_amount deadline achieved_at ai_tips created_at')
      .sort(achieved ? { achieved_at: -1 } : { created_at: -1 })
      .limit(100)
      .lean();

    const data = await enrichGoals(req.user!._id, goals, req.user!.currency || 'XAF');
    // Conseils IA du début / de la fin du mois : générés en arrière-plan s'ils manquent.
    if (!achieved && goals.length) void ensureGoalTips(req.user!._id);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Erreur get goals:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des objectifs',
    });
  }
});

/** Marque l'objectif comme réalisé : il passe dans l'historique. */
router.post('/:id/achieve', async (req: Request, res: Response) => {
  try {
    const goal = await SavingsGoal.findOneAndUpdate(
      { _id: req.params.id, user_id: req.user!._id, achieved_at: null },
      { $set: { achieved_at: new Date() } },
      { new: true }
    ).lean();
    if (!goal) {
      return res.status(404).json({ success: false, message: 'Objectif introuvable ou déjà atteint' });
    }
    const [data] = await enrichGoals(req.user!._id, [goal], req.user!.currency || 'XAF');
    return res.json({ success: true, data, message: 'Objectif atteint' });
  } catch (error) {
    console.error('Erreur achieve goal:', error);
    return res.status(500).json({ success: false, message: 'Erreur lors de la mise à jour' });
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

    if (!goal.achieved_at && (goal.saved_amount ?? 0) >= goal.target_amount) goal.achieved_at = new Date();
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
