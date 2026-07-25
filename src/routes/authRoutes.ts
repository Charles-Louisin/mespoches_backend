import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import Joi from 'joi';
import crypto from 'crypto';
import User, { IUser } from '../models/User';
import AuthHandoff from '../models/AuthHandoff';
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
import {
  authIpLimiter,
  loginLimiter,
  otpLimiter,
  availabilityLimiter,
} from '../utils/security';

const router = Router();

router.use(authIpLimiter);

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

const generateToken = (user: IUser): string => {
  return jwt.sign(
    {
      id: user._id,
      role: user.role,
      emailVerified: !!user.emailVerified,
    },
    process.env.JWT_SECRET as string,
    { expiresIn: JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
  );
};

const CURRENCY_VALUES = ['XAF', 'XOF', 'EURO', 'DOLLARS'];

const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(10).max(128).required(),
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

router.get('/check-availability', availabilityLimiter, async (req: Request, res: Response) => {
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

router.post('/register', loginLimiter, async (req: Request, res: Response) => {
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

router.post('/login', loginLimiter, async (req: Request, res: Response) => {
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

    if (user.authProvider === 'google' && !user.password) {
      return res.status(401).json({
        success: false,
        code: 'USE_GOOGLE',
        message: 'Ce compte utilise Google. Cliquez sur « Continuer avec Google ».',
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

    recordLogin(user, req);
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

router.post('/verify-email', otpLimiter, async (req: Request, res: Response) => {
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

    // Ne jamais émettre de JWT sans preuve OTP (évite le takeover si email déjà vérifié).
    if (user.emailVerified) {
      return res.status(400).json({
        success: false,
        code: 'ALREADY_VERIFIED',
        message: 'Cet email est déjà vérifié. Connectez-vous avec votre mot de passe.',
      });
    }

    const result = await verifyCode(user, code);
    if (result === 'locked') {
      return res.status(429).json({
        success: false,
        code: 'OTP_LOCKED',
        message:
          'Trop de codes incorrects. Demandez un nouveau code et réessayez.',
      });
    }
    if (result !== 'ok') {
      return res.status(400).json({
        success: false,
        message: 'Code incorrect ou expiré',
      });
    }

    user.emailVerified = true;
    user.verificationCode = null;
    user.verificationCodeExpires = null;
    user.verificationAttempts = 0;
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

router.post('/resend-code', otpLimiter, async (req: Request, res: Response) => {
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

function recordLogin(user: IUser, req: Request): void {
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
}

const googleSchema = Joi.object({
  idToken: Joi.string().required(),
  mobile: Joi.boolean().default(false),
  clientNonce: Joi.string().min(32).max(128).when('mobile', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
});

function hashHandoffCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function isValidHandoffCode(code: string): boolean {
  return /^[A-Za-z0-9_-]{32,128}$/.test(code);
}

router.post('/google', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { error, value } = googleSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Token Google manquant',
      });
    }

    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
    if (!clientId) {
      return res.status(500).json({
        success: false,
        message: 'GOOGLE_CLIENT_ID non configuré sur le serveur',
      });
    }

    const { OAuth2Client } = await import('google-auth-library');
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({
      idToken: value.idToken,
      audience: clientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      return res.status(401).json({
        success: false,
        message: 'Compte Google invalide',
      });
    }

    if (payload.email_verified === false) {
      return res.status(403).json({
        success: false,
        message: 'Email Google non vérifié',
      });
    }

    const googleId = payload.sub;
    const email = payload.email.toLowerCase().trim();
    const name = (payload.name || payload.given_name || '').trim();

    let user = await User.findOne({
      $or: [{ googleId }, { email }],
    });

    if (user) {
      if (!user.googleId) {
        user.googleId = googleId;
      }
      if (user.authProvider !== 'google' && !user.password) {
        user.authProvider = 'google';
      }
      if (!user.emailVerified) {
        user.emailVerified = true;
        user.verificationCode = null;
        user.verificationCodeExpires = null;
      }
      if (name && !user.name) {
        user.name = name;
      }
    } else {
      user = new User({
        email,
        name: name || undefined,
        googleId,
        authProvider: 'google',
        emailVerified: true,
      });
    }

    recordLogin(user, req);
    await user.save();

    const token = generateToken(user);

    if (value.mobile) {
      const handoffCode = crypto.randomBytes(32).toString('base64url');
      await AuthHandoff.create({
        codeHash: hashHandoffCode(handoffCode),
        clientNonceHash: hashHandoffCode(value.clientNonce),
        token,
        emailVerified: true,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });

      return res.status(200).json({
        success: true,
        data: { handoffCode },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        user: toPublicUser(user),
        token,
      },
    });
  } catch (err) {
    console.error('Erreur Google auth:', err);
    return res.status(401).json({
      success: false,
      message: 'Connexion Google impossible',
    });
  }
});

const handoffSchema = Joi.object({
  code: Joi.string().min(32).max(128).pattern(/^[A-Za-z0-9_-]+$/).required(),
  clientNonce: Joi.string().min(32).max(128).required(),
});

/** Échange atomique et à usage unique du code OAuth mobile contre la session JWT. */
router.post('/google/handoff', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { error, value } = handoffSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Code de retour Google invalide',
      });
    }

    if (!isValidHandoffCode(value.code)) {
      return res.status(400).json({
        success: false,
        message: 'Code de retour Google invalide',
      });
    }

    const handoff = await AuthHandoff.findOneAndDelete({
      codeHash: hashHandoffCode(value.code),
      clientNonceHash: hashHandoffCode(value.clientNonce),
      expiresAt: { $gt: new Date() },
    });

    if (!handoff) {
      return res.status(401).json({
        success: false,
        message: 'Code Google expiré, déjà utilisé, ou appareil non reconnu',
      });
    }

    return res.json({
      success: true,
      data: {
        token: handoff.token,
        user: { emailVerified: handoff.emailVerified },
      },
    });
  } catch (err) {
    console.error('Erreur Google handoff:', err);
    return res.status(500).json({
      success: false,
      message: 'Finalisation Google impossible',
    });
  }
});

export default router;
