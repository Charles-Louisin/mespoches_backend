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
import FeedbackMessage from '../models/FeedbackMessage';
import { invalidateUserCache, protect } from '../middleware/auth';
import { sendExistingAccountEmail } from '../utils/email';
import { toPublicUser } from '../utils/userPayload';
import { getNewUserTrialFields, syncExpiredPremium } from '../utils/subscription';
import {
  setVerificationCode,
  setPasswordResetCode,
  verifyCode,
  getResendCooldownSeconds,
} from '../utils/verification';
import {
  authIpLimiter,
  loginLimiter,
  otpLimiter,
  availabilityLimiter,
  handoffPollLimiter,
} from '../utils/security';
import {
  appendHandoffCode,
  buildOAuthState,
  googleCallbackUri,
  isAllowedAppReturnTo,
  isValidClientNonce,
  parseOAuthState,
} from '../utils/googleOAuth';

const router = Router();

router.use((req, res, next) => {
  if (req.method === 'GET') return next();
  if (req.path.endsWith('/google/handoff-poll')) return next();
  return authIpLimiter(req, res, next);
});

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
const NAME_MAX_LENGTH = 60;

const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(10).max(128).required(),
  name: Joi.string().max(NAME_MAX_LENGTH).allow('', null),
  currency: Joi.string().valid(...CURRENCY_VALUES).optional(),
});

const updateMeSchema = Joi.object({
  currency: Joi.string().valid(...CURRENCY_VALUES),
  hidePlannedExpensesHelp: Joi.boolean(),
  name: Joi.string().trim().min(2).max(NAME_MAX_LENGTH),
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

/**
 * Disponibilité du NOM public uniquement.
 * L'email n'est volontairement pas vérifiable ici : ce serait un oracle
 * d'énumération de comptes (cf. /register qui répond de façon générique).
 */
router.get('/check-availability', availabilityLimiter, async (req: Request, res: Response) => {
  try {
    const nameRaw = req.query.name as string | undefined;
    const data: {
      name?: { available: boolean };
    } = {};

    if (nameRaw && typeof nameRaw === 'string') {
      const name = nameRaw.trim().slice(0, NAME_MAX_LENGTH);
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

function mongoDupField(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const err = error as {
    code?: number;
    keyPattern?: Record<string, unknown>;
    keyValue?: Record<string, unknown>;
  };
  if (err.code !== 11000) return null;
  const keys = Object.keys(err.keyPattern || err.keyValue || {});
  return keys[0] ?? 'unknown';
}

router.post('/register', async (req: Request, res: Response) => {
  let emailNorm = '';
  try {
    const { error, value } = registerSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { email, password, name } = value;

    emailNorm = email.trim().toLowerCase();
    const nameNorm = name?.trim() || '';

    await User.updateMany({ googleId: null }, { $unset: { googleId: 1 } }).catch(
      () => undefined
    );

    // Réponse identique qu'un compte existe ou non (anti-énumération) :
    // c'est le titulaire de la boîte mail qui est informé, pas l'appelant.
    const userExists = await User.findOne({ email: emailNorm });
    if (userExists) {
      await sendExistingAccountEmail(emailNorm).catch(() => undefined);
      return res.status(201).json({
        success: true,
        needsVerification: true,
        message: 'Compte créé. Vérifiez votre email avec le code reçu.',
        data: { email: emailNorm },
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

    try {
      await setVerificationCode(user);
    } catch (err) {
      console.error('Erreur envoi verification après inscription:', err);
    }

    return res.status(201).json({
      success: true,
      needsVerification: true,
      message: 'Compte créé. Vérifiez votre email avec le code reçu.',
      data: { email: user.email },
    });
  } catch (error) {
    console.error('Erreur register:', error);
    const dup = mongoDupField(error);
    if (dup === 'name') {
      return res.status(400).json({
        success: false,
        message: 'Ce nom est déjà utilisé',
      });
    }

    if (emailNorm) {
      if (dup === 'googleId') {
        await User.updateMany({ googleId: null }, { $unset: { googleId: 1 } }).catch(
          () => undefined
        );
      }

      const existing = await User.findOne({ email: emailNorm });
      if (existing) {
        if (!existing.emailVerified) {
          await setVerificationCode(existing).catch((err) =>
            console.error('Erreur envoi verification après inscription:', err)
          );
        } else {
          await sendExistingAccountEmail(emailNorm).catch(() => undefined);
        }
        return res.status(201).json({
          success: true,
          needsVerification: true,
          message: 'Compte créé. Vérifiez votre email avec le code reçu.',
          data: { email: emailNorm },
        });
      }

      if (dup === 'googleId') {
        try {
          const retry = registerSchema.validate(req.body);
          if (!retry.error) {
            const user = await User.create({
              email: emailNorm,
              password: retry.value.password,
              name: retry.value.name?.trim() || undefined,
              role: 'user',
              emailVerified: false,
              currency: retry.value.currency || 'XAF',
              plan: 'free',
              premiumUntil: null,
              premiumSource: null,
            });
            await setVerificationCode(user).catch((err) =>
              console.error('Erreur envoi verification après inscription:', err)
            );
            return res.status(201).json({
              success: true,
              needsVerification: true,
              message: 'Compte créé. Vérifiez votre email avec le code reçu.',
              data: { email: user.email },
            });
          }
        } catch (retryErr) {
          console.error('Erreur register retry googleId:', retryErr);
        }
      }
    }

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
    const emailNorm = email.trim().toLowerCase();

    const user = await User.findOne({ email: emailNorm }).select('+password');
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Email ou mot de passe incorrect',
      });
    }

    // Compte Google sans mot de passe : proposer d'en définir un
    if (!user.password) {
      return res.status(401).json({
        success: false,
        code: 'NEED_PASSWORD',
        message:
          'Ce compte n’a pas encore de mot de passe. Cliquez sur « Mot de passe oublié » pour en créer un (code envoyé par email).',
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

    if (user.suspendedAt) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_SUSPENDED',
        message: 'Ce compte a été suspendu. Contactez le support.',
      });
    }

    // Si Google est aussi lié, marquer le compte comme double auth
    if (user.googleId && user.authProvider === 'email') {
      user.authProvider = 'both';
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

const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
});

const resetPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
  code: Joi.string().length(6).pattern(/^\d+$/).required(),
  password: Joi.string().min(10).max(128).required(),
});

/**
 * Envoie un code Resend pour définir / réinitialiser le mot de passe.
 * Réponse toujours générique (pas d’énumération d’emails).
 */
router.post('/forgot-password', otpLimiter, async (req: Request, res: Response) => {
  try {
    const { error, value } = forgotPasswordSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Email invalide',
      });
    }

    const email = value.email.trim().toLowerCase();
    const user = await User.findOne({ email }).select(
      '+verificationCode +password'
    );

    // Le cooldown ne doit rien révéler : on saute l'envoi en silence
    // plutôt que de renvoyer un 429 qui prouverait l'existence du compte.
    if (user && getResendCooldownSeconds(user) === 0) {
      try {
        await setPasswordResetCode(user);
      } catch (err) {
        console.error('Erreur envoi reset password:', err);
        return res.status(500).json({
          success: false,
          message: "Impossible d'envoyer l'email. Réessayez plus tard.",
        });
      }
    }

    return res.status(200).json({
      success: true,
      message:
        'Si un compte existe pour cet email, un code de vérification a été envoyé.',
      data: { email },
    });
  } catch (error) {
    console.error('Erreur forgot-password:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la demande',
    });
  }
});

/** Vérifie le code email puis définit le nouveau mot de passe. */
router.post('/reset-password', otpLimiter, async (req: Request, res: Response) => {
  try {
    const { error, value } = resetPasswordSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const email = value.email.trim().toLowerCase();
    const user = await User.findOne({ email }).select(
      '+verificationCode +password'
    );
    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Code invalide ou email inconnu',
      });
    }

    const result = await verifyCode(user, value.code);
    if (result === 'locked') {
      return res.status(429).json({
        success: false,
        code: 'OTP_LOCKED',
        message: 'Trop de tentatives. Demandez un nouveau code.',
      });
    }
    if (result !== 'ok') {
      return res.status(400).json({
        success: false,
        message: 'Code invalide ou expiré',
      });
    }

    user.password = value.password;
    user.verificationCode = null;
    user.verificationCodeExpires = null;
    user.emailVerified = true;
    if (user.googleId) {
      user.authProvider = 'both';
    } else if (user.authProvider === 'google') {
      user.authProvider = 'email';
    }
    await revokeAllSessions(user);
    await user.save();
    invalidateUserCache(String(user._id));

    const token = generateToken(user);
    return res.status(200).json({
      success: true,
      message: 'Mot de passe mis à jour. Vous êtes connecté.',
      data: {
        user: toPublicUser(user),
        token,
      },
    });
  } catch (error) {
    console.error('Erreur reset-password:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la réinitialisation',
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
    // Même réponse qu'un code erroné : ne pas révéler l'absence de compte.
    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Code incorrect ou expiré',
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

    // Réponse générique : compte inexistant, déjà vérifié ou en cooldown
    // donnent tous le même résultat visible côté appelant.
    const generic = {
      success: true,
      message: 'Un nouveau code a été envoyé à votre adresse email',
      data: { email },
    };

    if (user && !user.emailVerified && getResendCooldownSeconds(user) === 0) {
      try {
        await setVerificationCode(user);
      } catch (err) {
        console.error('Erreur envoi verification resend:', err);
      }
    }

    return res.status(200).json(generic);
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
    if (value.name) {
      const name = String(value.name).trim();
      const taken = await User.exists({
        _id: { $ne: user._id },
        name: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') },
      });
      if (taken) {
        return res.status(409).json({
          success: false,
          message: 'Ce nom est déjà utilisé',
        });
      }
      user.name = name;
    }
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

    if (value.currency || value.hidePlannedExpensesHelp !== undefined || value.name) {
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
      FeedbackMessage.deleteMany({ user_id: userId }),
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
      invalidateUserCache(String(user._id));
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
    const path = parsed.pathname.replace(/\/$/, '');
    if (path !== '/api/auth/google/callback') return false;
    const host = parsed.hostname.toLowerCase();
    if (/^(localhost|127\.0\.0\.1)$/i.test(host)) return true;
    if (parsed.protocol !== 'https:') return false;
    // Google valide déjà l’URI dans sa console — on accepte nos domaines connus.
    if (host === 'mespoches.store' || host.endsWith('.mespoches.store')) return true;
    if (host === 'mespoches.vercel.app' || host.endsWith('.vercel.app')) return true;
    if (host.endsWith('.up.railway.app')) return true;
    const allowed = new Set(
      [
        ...(process.env.CORS_ORIGIN || '').split(','),
        process.env.APP_URL,
        process.env.API_PUBLIC_URL,
      ]
        .map((o) => o?.trim().replace(/\/$/, ''))
        .filter((o): o is string => Boolean(o))
    );
    if (allowed.has(parsed.origin)) return true;
    for (const raw of allowed) {
      try {
        if (new URL(raw).origin === parsed.origin) return true;
      } catch {
        /* ignore */
      }
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
      // Liaison Google : on GARDE le mot de passe s'il existe (double connexion).
      byEmail.googleId = googleId;
      byEmail.emailVerified = true;
      byEmail.verificationCode = null;
      byEmail.verificationCodeExpires = null;
      if (byEmail.password) {
        byEmail.authProvider = 'both';
      } else {
        byEmail.authProvider = 'google';
      }
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

  if (user.suspendedAt) {
    return {
      status: 403,
      body: {
        success: false,
        code: 'ACCOUNT_SUSPENDED',
        message: 'Ce compte a été suspendu. Contactez le support.',
      },
    };
  }

  recordLogin(user, req);
  await user.save();
  await syncExpiredPremium(user);

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

/** Démarre OAuth Google (navigateur Expo) — ne dépend plus de Next.js. */
router.get('/google', async (req: Request, res: Response) => {
  const clientId = googleClientId();
  if (!clientId) {
    return res.status(503).json({
      success: false,
      message: 'GOOGLE_CLIENT_ID non configuré sur le serveur',
    });
  }

  const mobile = req.query.mobile === '1';
  const clientNonce =
    typeof req.query.client_nonce === 'string' ? req.query.client_nonce : null;
  const returnTo = typeof req.query.return_to === 'string' ? req.query.return_to : null;

  if (mobile && !isValidClientNonce(clientNonce)) {
    return res.status(400).json({
      success: false,
      message: 'Nonce Google invalide',
    });
  }

  const redirectUri = googleCallbackUri(req);
  const state = buildOAuthState(mobile, {
    returnTo: isAllowedAppReturnTo(returnTo) ? returnTo : undefined,
    nonce: mobile && clientNonce ? clientNonce : undefined,
  });

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('access_type', 'online');
  url.searchParams.set('prompt', 'select_account');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return res.redirect(url.toString());
});

router.get('/google/callback', async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const oauthError = typeof req.query.error === 'string' ? req.query.error : null;
  const parsedState = parseOAuthState(
    typeof req.query.state === 'string' ? req.query.state : null
  );
  const mobile = parsedState?.mobile === true;
  const clientNonce = parsedState?.nonce;
  const returnTo = parsedState?.returnTo;
  const bounce = (extra: string) => {
    if (isAllowedAppReturnTo(returnTo)) {
      const sep = returnTo.includes('?') ? '&' : '?';
      return res.redirect(`${returnTo}${sep}${extra}`);
    }
    return res.status(400).send('Connexion Google impossible');
  };

  if (oauthError || !code) {
    return bounce(`error=${encodeURIComponent(oauthError || 'google_denied')}`);
  }
  if (!parsedState) {
    return bounce('error=google_state');
  }
  if (mobile && (!clientNonce || clientNonce.length < 32)) {
    return bounce('error=google_nonce');
  }

  const clientId = googleClientId();
  const clientSecret = googleClientSecret();
  const redirectUri = googleCallbackUri(req);
  if (!clientId || !clientSecret) {
    return bounce('error=google_config');
  }
  if (!isAllowedOAuthRedirectUri(redirectUri)) {
    return bounce('error=google_redirect');
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = (await tokenRes.json()) as {
      id_token?: string;
      error?: string;
    };
    if (!tokenRes.ok || !tokenData.id_token) {
      console.error('Google token exchange failed:', tokenData.error);
      return bounce('error=google_token');
    }

    const result = await completeGoogleLogin(req, {
      idToken: tokenData.id_token,
      mobile,
      clientNonce,
    });
    if (result.status !== 200 || !result.body.success) {
      return bounce('error=google_failed');
    }

    if (mobile) {
      const inner =
        result.body.data && typeof result.body.data === 'object'
          ? (result.body.data as Record<string, unknown>)
          : null;
      const handoffCode = inner?.handoffCode;
      if (typeof handoffCode !== 'string' || !isAllowedAppReturnTo(returnTo)) {
        return bounce('error=google_session');
      }
      return res.redirect(appendHandoffCode(returnTo, handoffCode));
    }

    return bounce('error=google_web');
  } catch (err) {
    console.error('Google callback error:', err);
    return bounce('error=google_failed');
  }
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
router.post('/google/exchange', async (req: Request, res: Response) => {
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

router.post('/google', async (req: Request, res: Response) => {
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

const handoffPollSchema = Joi.object({
  clientNonce: Joi.string().min(32).max(128).required(),
});

/** Échange atomique et à usage unique du code OAuth mobile contre la session JWT. */
router.post('/google/handoff', async (req: Request, res: Response) => {
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

/**
 * L’APK poll ce endpoint si Chrome Custom Tabs n’a pas renvoyé le deep link
 * alors que le compte Google est déjà créé.
 */
router.post('/google/handoff-poll', handoffPollLimiter, async (req: Request, res: Response) => {
  try {
    const { error, value } = handoffPollSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Nonce Google invalide',
      });
    }

    const handoff = await AuthHandoff.findOneAndDelete(
      {
        clientNonceHash: hashHandoffCode(value.clientNonce),
        expiresAt: { $gt: new Date() },
      },
      { sort: { createdAt: -1 } }
    );

    if (!handoff) {
      return res.status(202).json({ success: false, pending: true });
    }

    return res.json({
      success: true,
      data: {
        token: handoff.token,
        user: { emailVerified: handoff.emailVerified },
      },
    });
  } catch (err) {
    console.error('Erreur Google handoff-poll:', err);
    return res.status(202).json({ success: false, pending: true });
  }
});

export default router;
