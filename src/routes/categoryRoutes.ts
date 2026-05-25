import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { FilterQuery } from 'mongoose';
import Category, { ICategory } from '../models/Category';
import { protect, sendLimitError } from '../middleware/auth';
import { PLAN_LIMITS } from '../config/planLimits';
import { isPremiumUser } from '../utils/subscription';

const router = Router();

const categorySchema = Joi.object({
  name: Joi.string().required(),
  type: Joi.string().valid('income', 'expense').required(),
  image_url: Joi.string().uri().allow(null, '').optional(),
});

const categoryUpdateSchema = Joi.object({
  name: Joi.string().optional(),
  type: Joi.string().valid('income', 'expense').optional(),
  image_url: Joi.string().uri().allow(null, '').optional(),
});

router.get('/', protect, async (req: Request, res: Response) => {
  try {
    const type = req.query.type;
    const query: FilterQuery<ICategory> = { user_id: req.user!._id };

    if (typeof type === 'string' && (type === 'income' || type === 'expense')) {
      query.type = type;
    }

    const categories = await Category.find(query).sort({ name: 1 });

    return res.json({
      success: true,
      count: categories.length,
      data: categories,
    });
  } catch (error) {
    console.error('Erreur get categories:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des catégories',
    });
  }
});

router.get('/:id', protect, async (req: Request, res: Response) => {
  try {
    const category = await Category.findOne({
      _id: req.params.id,
      user_id: req.user!._id,
    });

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Catégorie introuvable',
      });
    }

    return res.json({ success: true, data: category });
  } catch (error) {
    console.error('Erreur get category:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération de la catégorie',
    });
  }
});

router.post('/', protect, async (req: Request, res: Response) => {
  try {
    const { error, value } = categorySchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const count = await Category.countDocuments({
      user_id: req.user!._id,
      type: value.type,
    });
    if (
      !isPremiumUser(req.user!) &&
      count >= PLAN_LIMITS.FREE_MAX_CATEGORIES_PER_TYPE
    ) {
      return sendLimitError(
        res,
        `Limite atteinte : ${PLAN_LIMITS.FREE_MAX_CATEGORIES_PER_TYPE} catégories ${value.type === 'income' ? 'de revenus' : 'de dépenses'} maximum en version gratuite.`,
        { premium: true }
      );
    }

    if (value.image_url && !isPremiumUser(req.user!)) {
      return sendLimitError(
        res,
        'Les images personnalisées sont réservées aux abonnés Premium.',
        { premium: true }
      );
    }

    const category = await Category.create({
      user_id: req.user!._id,
      name: value.name,
      type: value.type,
      image_url: isPremiumUser(req.user!) ? value.image_url || null : null,
    });

    return res.status(201).json({
      success: true,
      data: category,
    });
  } catch (error) {
    console.error('Erreur create category:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la création de la catégorie',
    });
  }
});

router.put('/:id', protect, async (req: Request, res: Response) => {
  try {
    const { error, value } = categoryUpdateSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const category = await Category.findOne({
      _id: req.params.id,
      user_id: req.user!._id,
    });

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Catégorie introuvable',
      });
    }

    if (value.name) category.name = value.name;
    if (value.type) category.type = value.type;
    if (value.image_url !== undefined) {
      if (!isPremiumUser(req.user!) && value.image_url) {
        return sendLimitError(
          res,
          'Les images personnalisées sont réservées aux abonnés Premium.',
          { premium: true }
        );
      }
      category.image_url = value.image_url || null;
    }

    await category.save();

    return res.json({ success: true, data: category });
  } catch (error) {
    console.error('Erreur update category:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour de la catégorie',
    });
  }
});

router.delete('/:id', protect, async (req: Request, res: Response) => {
  try {
    const category = await Category.findOne({
      _id: req.params.id,
      user_id: req.user!._id,
    });

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Catégorie introuvable',
      });
    }

    await Category.findByIdAndDelete(req.params.id);

    return res.json({
      success: true,
      message: 'Catégorie supprimée avec succès',
    });
  } catch (error) {
    console.error('Erreur delete category:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la suppression de la catégorie',
    });
  }
});

export default router;
