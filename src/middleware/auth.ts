import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import User, { IUser } from '../models/User';
import { isPremiumUser, syncExpiredPremium } from '../utils/subscription';
import { PREMIUM_REQUIRED_CODE } from '../config/planLimits';

interface JwtPayload {
  id: string;
  role: string;
  tv?: number;
}

const USER_CACHE_TTL_MS = 8_000;
const USER_CACHE_MAX = 2_000;
const userCache = new Map<string, { user: IUser; exp: number }>();

function cacheKey(id: string, tv: number): string {
  return `${id}:${tv}`;
}

export function invalidateUserCache(userId: string): void {
  const prefix = `${userId}:`;
  for (const key of userCache.keys()) {
    if (key.startsWith(prefix)) userCache.delete(key);
  }
}

export async function protect(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  let token: string | undefined;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET as string
      ) as JwtPayload;

      const tv = decoded.tv ?? 0;
      const key = cacheKey(decoded.id, tv);
      const hit = userCache.get(key);
      let user: IUser | null = hit && hit.exp > Date.now() ? hit.user : null;

      if (!user) {
        user = (await User.findById(decoded.id).select('-password -loginHistory -verificationCode')) as IUser | null;
        if (user) {
          if (userCache.size >= USER_CACHE_MAX) {
            const first = userCache.keys().next().value;
            if (first) userCache.delete(first);
          }
          userCache.set(key, { user, exp: Date.now() + USER_CACHE_TTL_MS });
        }
      }

      if (!user) {
        res.status(401).json({
          success: false,
          message: 'Utilisateur introuvable',
        });
        return;
      }

      const tokenVersion = user.tokenVersion ?? 0;
      if (tv !== tokenVersion) {
        userCache.delete(key);
        res.status(401).json({
          success: false,
          code: 'SESSION_REVOKED',
          message: 'Session expirée. Reconnectez-vous.',
        });
        return;
      }

      if (!user.emailVerified) {
        res.status(403).json({
          success: false,
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Veuillez vérifier votre adresse email',
          data: { email: user.email },
        });
        return;
      }

      await syncExpiredPremium(user);

      req.user = user as IUser;
      next();
      return;
    } catch {
      res.status(401).json({
        success: false,
        message: 'Non autorisé, token invalide',
      });
      return;
    }
  }

  res.status(401).json({
    success: false,
    message: 'Non autorisé, pas de token',
  });
}

export function adminOnly(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({
      success: false,
      message: 'Accès réservé aux administrateurs',
    });
    return;
  }
  next();
}

export function premiumOnly(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user || !isPremiumUser(req.user)) {
    res.status(403).json({
      success: false,
      code: PREMIUM_REQUIRED_CODE,
      message: 'Cette fonctionnalité nécessite un abonnement Premium',
    });
    return;
  }
  next();
}

export function sendLimitError(
  res: Response,
  message: string,
  opts?: { premium?: boolean }
): void {
  res.status(403).json({
    success: false,
    code: opts?.premium ? PREMIUM_REQUIRED_CODE : 'LIMIT_REACHED',
    message,
  });
}
