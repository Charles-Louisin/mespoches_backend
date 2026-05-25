import { Router, Request, Response } from 'express';
import Joi from 'joi';
import Budget from '../models/Budget';
import Category from '../models/Category';
import Transaction from '../models/Transaction';
import { protect, premiumOnly } from '../middleware/auth';

const router = Router();

const budgetSchema = Joi.object({
  category_id: Joi.string().required(),
  year: Joi.number().integer().min(2000).required(),
  month: Joi.number().integer().min(1).max(12).required(),
  limit_amount: Joi.number().min(0).required(),
});

router.use(protect, premiumOnly);

router.get('/', async (req: Request, res: Response) => {
  try {
    const year = parseInt(req.query.year as string, 10) || new Date().getFullYear();
    const month =
      parseInt(req.query.month as string, 10) || new Date().getMonth() + 1;

    const budgets = await Budget.find({
      user_id: req.user!._id,
      year,
      month,
    }).populate('category_id');

    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0, 23, 59, 59);

    const enriched = await Promise.all(
      budgets.map(async (b) => {
        const catId = b.category_id;
        const spent = await Transaction.aggregate([
          {
            $match: {
              user_id: req.user!._id,
              type: 'expense',
              category_id: catId,
              date: { $gte: start, $lte: end },
            },
          },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]);
        const spentAmount = spent[0]?.total ?? 0;
        return {
          ...b.toObject(),
          spent: spentAmount,
          percent: b.limit_amount > 0 ? (spentAmount / b.limit_amount) * 100 : 0,
        };
      })
    );

    return res.json({ success: true, count: enriched.length, data: enriched });
  } catch (error) {
    console.error('Erreur get budgets:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des budgets',
    });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { error, value } = budgetSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const category = await Category.findOne({
      _id: value.category_id,
      user_id: req.user!._id,
      type: 'expense',
    });
    if (!category) {
      return res.status(400).json({
        success: false,
        message: 'Catégorie de dépense invalide',
      });
    }

    const budget = await Budget.create({
      user_id: req.user!._id,
      ...value,
    });

    const populated = await Budget.findById(budget._id).populate('category_id');
    return res.status(201).json({ success: true, data: populated });
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code: number }).code === 11000
    ) {
      return res.status(400).json({
        success: false,
        message: 'Un budget existe déjà pour cette catégorie ce mois-ci',
      });
    }
    console.error('Erreur create budget:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la création du budget',
    });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { limit_amount } = req.body;
    if (typeof limit_amount !== 'number' || limit_amount < 0) {
      return res.status(400).json({
        success: false,
        message: 'Montant limite invalide',
      });
    }

    const budget = await Budget.findOneAndUpdate(
      { _id: req.params.id, user_id: req.user!._id },
      { limit_amount },
      { new: true }
    ).populate('category_id');

    if (!budget) {
      return res.status(404).json({
        success: false,
        message: 'Budget introuvable',
      });
    }

    return res.json({ success: true, data: budget });
  } catch (error) {
    console.error('Erreur update budget:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour du budget',
    });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await Budget.findOneAndDelete({
      _id: req.params.id,
      user_id: req.user!._id,
    });
    if (!result) {
      return res.status(404).json({
        success: false,
        message: 'Budget introuvable',
      });
    }
    return res.json({ success: true, message: 'Budget supprimé' });
  } catch (error) {
    console.error('Erreur delete budget:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la suppression du budget',
    });
  }
});

export default router;
