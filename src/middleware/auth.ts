import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import User, { IUser } from '../models/User';
import { isPremiumUser } from '../utils/subscription';
import { PREMIUM_REQUIRED_CODE } from '../config/planLimits';

interface JwtPayload {
  id: string;
  role: string;
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

      const user = await User.findById(decoded.id).select('-password');
      if (!user) {
        res.status(401).json({
          success: false,
          message: 'Utilisateur introuvable',
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

      req.user = user as IUser;
      next();
      return;
    } catch (error) {
      console.error('Erreur auth:', error);
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
