import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import Joi from 'joi';
import User, { IUser } from '../models/User';
import Wallet from '../models/Wallet';
import Transaction from '../models/Transaction';
import Category from '../models/Category';
import Budget from '../models/Budget';
import SavingsGoal from '../models/SavingsGoal';
import RecurringTransaction from '../models/RecurringTransaction';
import PlannedExpense from '../models/PlannedExpense';
import { protect } from '../middleware/auth';
import { toPublicUser } from '../utils/userPayload';
import {
  setVerificationCode,
  verifyCode,
  getResendCooldownSeconds,
} from '../utils/verification';

const router = Router();

const generateToken = (user: IUser): string => {
  return jwt.sign(
    { id: user._id, role: user.role },
    process.env.JWT_SECRET as string,
    { expiresIn: '30d' }
  );
};

const CURRENCY_VALUES = ['XAF', 'XOF', 'EURO', 'DOLLARS'];

const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  name: Joi.string().allow('', null),
  currency: Joi.string().valid(...CURRENCY_VALUES).optional(),
});

const updateMeSchema = Joi.object({
  currency: Joi.string().valid(...CURRENCY_VALUES),
  hidePlannedExpensesHelp: Joi.boolean(),
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

const verifySchema = Joi.object({
  email: Joi.string().email().required(),
  code: Joi.string().length(6).pattern(/^\d+$/).required(),
});

const resendSchema = Joi.object({
  email: Joi.string().email().required(),
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

router.get('/check-availability', async (req: Request, res: Response) => {
  try {
    const emailRaw = req.query.email as string | undefined;
    const nameRaw = req.query.name as string | undefined;
    const data: {
      email?: { available: boolean };
      name?: { available: boolean };
    } = {};

    if (emailRaw && typeof emailRaw === 'string') {
      const email = emailRaw.trim().toLowerCase();
      if (email) {
        const exists = await User.exists({ email });
        data.email = { available: !exists };
      }
    }

    if (nameRaw && typeof nameRaw === 'string') {
      const name = nameRaw.trim();
      if (name.length >= 2) {
        const exists = await User.exists({
          name: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') },
        });
        data.name = { available: !exists };
      }
    }

    return res.json({ success: true, data });
  } catch (error) {
    console.error('Erreur check-availability:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification',
    });
  }
});

router.post('/register', async (req: Request, res: Response) => {
  try {
    const { error, value } = registerSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { email, password, name } = value;

    const emailNorm = email.trim().toLowerCase();
    const nameNorm = name?.trim() || '';

    const userExists = await User.findOne({ email: emailNorm });
    if (userExists) {
      return res.status(400).json({
        success: false,
        message: 'Un compte existe déjà avec cet email',
      });
    }

    if (nameNorm) {
      const nameTaken = await User.exists({
        name: { $regex: new RegExp(`^${escapeRegex(nameNorm)}$`, 'i') },
      });
      if (nameTaken) {
        return res.status(400).json({
          success: false,
          message: 'Ce nom est déjà utilisé',
        });
      }
    }

    const user = await User.create({
      email: emailNorm,
      password,
      name: nameNorm || name,
      role: 'user',
      emailVerified: false,
      currency: value.currency || 'XAF',
    });

    await setVerificationCode(user);

    return res.status(201).json({
      success: true,
      needsVerification: true,
      message: 'Compte créé. Vérifiez votre email avec le code reçu.',
      data: { email: user.email },
    });
  } catch (error) {
    console.error('Erreur register:', error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de l'inscription",
    });
  }
});

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { error, value } = loginSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { email, password } = value;

    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Email ou mot de passe incorrect',
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Email ou mot de passe incorrect',
      });
    }

    if (!user.emailVerified) {
      return res.status(403).json({
        success: false,
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Veuillez vérifier votre adresse email avant de vous connecter',
        data: { email: user.email },
      });
    }

    const now = new Date();
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      (typeof forwarded === 'string'
        ? forwarded.split(',')[0].trim()
        : Array.isArray(forwarded)
          ? forwarded[0]
          : null) ||
      req.socket.remoteAddress ||
      null;
    const userAgent = req.headers['user-agent'] || null;

    user.lastLoginAt = now;
    user.loginHistory = user.loginHistory || [];
    user.loginHistory.push({ date: now, ip, userAgent });
    await user.save();

    const token = generateToken(user);

    return res.status(200).json({
      success: true,
      data: {
        user: toPublicUser(user),
        token,
      },
    });
  } catch (error) {
    console.error('Erreur login:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la connexion',
    });
  }
});

router.post('/verify-email', async (req: Request, res: Response) => {
  try {
    const { error, value } = verifySchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Code invalide (6 chiffres requis)',
      });
    }

    const { email, code } = value;

    const user = await User.findOne({ email }).select(
      '+verificationCode +password'
    );
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Aucun compte associé à cet email',
      });
    }

    if (user.emailVerified) {
      const token = generateToken(user);
      return res.status(200).json({
        success: true,
        message: 'Email déjà vérifié',
        data: {
          user: toPublicUser(user),
          token,
        },
      });
    }

    const valid = await verifyCode(user, code);
    if (!valid) {
      return res.status(400).json({
        success: false,
        message: 'Code incorrect ou expiré',
      });
    }

    user.emailVerified = true;
    user.verificationCode = null;
    user.verificationCodeExpires = null;
    await user.save();

    const token = generateToken(user);

    return res.status(200).json({
      success: true,
      message: 'Email vérifié avec succès',
      data: {
        user: toPublicUser(user),
        token,
      },
    });
  } catch (error) {
    console.error('Erreur verify-email:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification',
    });
  }
});

router.post('/resend-code', async (req: Request, res: Response) => {
  try {
    const { error, value } = resendSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { email } = value;

    const user = await User.findOne({ email }).select('+verificationCode');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Aucun compte associé à cet email',
      });
    }

    if (user.emailVerified) {
      return res.status(400).json({
        success: false,
        message: 'Cet email est déjà vérifié',
      });
    }

    const cooldown = getResendCooldownSeconds(user);
    if (cooldown > 0) {
      return res.status(429).json({
        success: false,
        code: 'RESEND_COOLDOWN',
        message: `Veuillez attendre ${cooldown} seconde(s) avant de renvoyer le code`,
        data: { cooldownSeconds: cooldown },
      });
    }

    await setVerificationCode(user);

    return res.status(200).json({
      success: true,
      message: 'Un nouveau code a été envoyé à votre adresse email',
      data: { email: user.email },
    });
  } catch (error) {
    console.error('Erreur resend-code:', error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de l'envoi du code",
    });
  }
});

router.get('/me', protect, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    return res.json({
      success: true,
      data: toPublicUser(user),
    });
  } catch (error) {
    console.error('Erreur auth me:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération du profil',
    });
  }
});

router.patch('/me', protect, async (req: Request, res: Response) => {
  try {
    const { error, value } = updateMeSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const user = req.user!;
    if (value.currency) {
      user.currency = value.currency;
      await Wallet.updateMany(
        { user_id: user._id, is_deleted: { $ne: true } },
        { currency: value.currency }
      );
    }
    if (value.hidePlannedExpensesHelp !== undefined) {
      user.hidePlannedExpensesHelp = value.hidePlannedExpensesHelp;
    }

    if (value.currency || value.hidePlannedExpensesHelp !== undefined) {
      await user.save();
    }

    return res.json({
      success: true,
      data: toPublicUser(user),
    });
  } catch (error) {
    console.error('Erreur patch me:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour du profil',
    });
  }
});

router.delete('/me', protect, async (req: Request, res: Response) => {
  try {
    const userId = req.user!._id;

    await Promise.all([
      Transaction.deleteMany({ user_id: userId }),
      Wallet.deleteMany({ user_id: userId }),
      Category.deleteMany({ user_id: userId }),
      Budget.deleteMany({ user_id: userId }),
      SavingsGoal.deleteMany({ user_id: userId }),
      RecurringTransaction.deleteMany({ user_id: userId }),
      PlannedExpense.deleteMany({ user_id: userId }),
      User.deleteOne({ _id: userId }),
    ]);

    return res.json({
      success: true,
      message: 'Compte supprimé avec succès',
    });
  } catch (error) {
    console.error('Erreur delete account:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la suppression du compte',
    });
  }
});

export default router;
