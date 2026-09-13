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
import PendingTransaction from '../models/PendingTransaction';
import SmsHabit from '../models/SmsHabit';
import NotificationPattern from '../models/NotificationPattern';
import SubscriptionPayment from '../models/SubscriptionPayment';
import { protect } from '../middleware/auth';
import { toPublicUser } from '../utils/userPayload';
import { getNewUserTrialFields, syncExpiredPremium } from '../utils/subscription';
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

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

const generateToken = (user: IUser): string => {
  return jwt.sign(
    {
      id: user._id,
      role: user.role,
      emailVerified: !!user.emailVerified,
      tv: user.tokenVersion ?? 0,
    },
    process.env.JWT_SECRET as string,
    { expiresIn: JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
  );
};

/** Invalide tous les JWT déjà émis pour cet utilisateur. */
async function revokeAllSessions(user: IUser): Promise<void> {
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
}

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
      plan: 'free',
      premiumUntil: null,
      premiumSource: null,
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
    await syncExpiredPremium(user);

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
    // L'essai Premium commence uniquement après vérification de l'email.
    Object.assign(user, getNewUserTrialFields());
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
      PendingTransaction.deleteMany({ user_id: userId }),
      SmsHabit.deleteMany({ user_id: userId }),
      NotificationPattern.deleteMany({ user_id: userId }),
      SubscriptionPayment.deleteMany({ user_id: userId }),
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

/** Invalide toutes les sessions JWT de l'utilisateur. */
router.post('/logout', protect, async (req: Request, res: Response) => {
  try {
    const user = await User.findById(req.user!._id);
    if (user) {
      await revokeAllSessions(user);
      await user.save();
    }
    return res.json({ success: true, message: 'Déconnecté' });
  } catch (error) {
    console.error('Erreur logout:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la déconnexion',
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
  if (user.loginHistory.length > 20) {
    user.loginHistory = user.loginHistory.slice(-20);
  }
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

function googleClientId(): string {
  return process.env.GOOGLE_CLIENT_ID?.trim() || '';
}

function googleClientSecret(): string {
  return process.env.GOOGLE_CLIENT_SECRET?.trim() || '';
}

function isAllowedOAuthRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.pathname !== '/api/auth/google/callback') return false;
    const allowed = new Set(
      [
        ...(process.env.CORS_ORIGIN || '').split(','),
        process.env.APP_URL,
        'https://mespoches.vercel.app',
        'https://mespoches.store',
        'https://www.mespoches.store',
      ]
        .map((o) => o?.trim().replace(/\/$/, ''))
        .filter(Boolean)
    );
    if (allowed.has(parsed.origin)) return true;
    if (parsed.hostname.endsWith('.vercel.app')) return true;
    if (process.env.NODE_ENV !== 'production') {
      return /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(parsed.hostname);
    }
    return false;
  } catch {
    return false;
  }
}

async function completeGoogleLogin(
  req: Request,
  value: { idToken: string; mobile: boolean; clientNonce?: string }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const clientId = googleClientId();
  if (!clientId) {
    return {
      status: 500,
      body: {
        success: false,
        message: 'GOOGLE_CLIENT_ID non configuré sur le serveur',
      },
    };
  }

  const { OAuth2Client } = await import('google-auth-library');
  const client = new OAuth2Client(clientId);
  const ticket = await client.verifyIdToken({
    idToken: value.idToken,
    audience: clientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    return {
      status: 401,
      body: { success: false, message: 'Compte Google invalide' },
    };
  }

  if (payload.email_verified === false) {
    return {
      status: 403,
      body: { success: false, message: 'Email Google non vérifié' },
    };
  }

  const googleId = payload.sub;
  const email = payload.email.toLowerCase().trim();
  const name = (payload.name || payload.given_name || '').trim();

  let user = await User.findOne({ googleId });

  if (!user) {
    const byEmail = await User.findOne({ email }).select('+password');
    if (byEmail) {
      byEmail.googleId = googleId;
      byEmail.authProvider = 'google';
      byEmail.emailVerified = true;
      byEmail.password = undefined;
      byEmail.set('password', undefined);
      byEmail.verificationCode = null;
      byEmail.verificationCodeExpires = null;
      await revokeAllSessions(byEmail);
      if (name && !byEmail.name) byEmail.name = name;
      user = byEmail;
    } else {
      user = new User({
        email,
        name: name || undefined,
        googleId,
        authProvider: 'google',
        emailVerified: true,
        ...getNewUserTrialFields(),
      });
    }
  } else {
    if (!user.emailVerified) {
      user.emailVerified = true;
      user.verificationCode = null;
      user.verificationCodeExpires = null;
    }
    if (name && !user.name) {
      user.name = name;
    }
  }

  recordLogin(user, req);
  await user.save();
  await syncExpiredPremium(user);

  if (user.authProvider === 'google' && user.password === undefined) {
    await User.updateOne({ _id: user._id }, { $unset: { password: 1 } });
  }

  const token = generateToken(user);

  if (value.mobile) {
    if (!value.clientNonce) {
      return {
        status: 400,
        body: { success: false, message: 'Nonce mobile manquant' },
      };
    }
    const handoffCode = crypto.randomBytes(32).toString('base64url');
    await AuthHandoff.create({
      codeHash: hashHandoffCode(handoffCode),
      clientNonceHash: hashHandoffCode(value.clientNonce),
      token,
      emailVerified: true,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    return { status: 200, body: { success: true, data: { handoffCode } } };
  }

  return {
    status: 200,
    body: {
      success: true,
      data: {
        user: toPublicUser(user),
        token,
      },
    },
  };
}

/** Client ID public — le front Vercel n’a pas besoin de recopier le secret. */
router.get('/google/client', async (_req: Request, res: Response) => {
  const clientId = googleClientId();
  if (!clientId) {
    return res.status(503).json({
      success: false,
      message: 'GOOGLE_CLIENT_ID non configuré sur le serveur',
    });
  }
  return res.json({ success: true, data: { clientId } });
});

const exchangeSchema = Joi.object({
  code: Joi.string().required(),
  redirectUri: Joi.string().uri().required(),
  mobile: Joi.boolean().default(false),
  clientNonce: Joi.string().min(32).max(128).when('mobile', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
});

/** Échange le code OAuth (Vercel) contre une session — secret uniquement ici. */
router.post('/google/exchange', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { error, value } = exchangeSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Code Google invalide',
      });
    }

    const clientId = googleClientId();
    const clientSecret = googleClientSecret();
    if (!clientId || !clientSecret) {
      return res.status(500).json({
        success: false,
        message: 'GOOGLE_CLIENT_ID / SECRET non configurés sur le serveur',
      });
    }

    if (!isAllowedOAuthRedirectUri(value.redirectUri)) {
      return res.status(400).json({
        success: false,
        message: 'redirect_uri Google non autorisé',
      });
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: value.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: value.redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = (await tokenRes.json()) as {
      id_token?: string;
      error?: string;
    };

    if (!tokenRes.ok || !tokenData.id_token) {
      console.error('Google token exchange failed:', tokenData.error);
      return res.status(401).json({
        success: false,
        message: 'Échange Google impossible. Réessayez.',
      });
    }

    const result = await completeGoogleLogin(req, {
      idToken: tokenData.id_token,
      mobile: value.mobile,
      clientNonce: value.clientNonce,
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Erreur Google exchange:', err);
    return res.status(401).json({
      success: false,
      message: 'Connexion Google impossible',
    });
  }
});

router.post('/google', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { error, value } = googleSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Token Google manquant',
      });
    }

    const result = await completeGoogleLogin(req, value);
    return res.status(result.status).json(result.body);
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
