import crypto from 'crypto';
import { Request, Response } from 'express';

/**
 * Protège les endpoints d'info ops (IP CinetPay, checklist).
 * En production : exige CINETPAY_SETUP_SECRET (header X-Setup-Secret ou ?secret=).
 * En développement : ouvert si le secret n'est pas défini.
 */
export function assertSetupAccess(req: Request, res: Response): boolean {
  const secret = (
    process.env.CINETPAY_SETUP_SECRET ||
    process.env.ADMIN_SETUP_SECRET ||
    ''
  ).trim();
  const isProduction = (process.env.NODE_ENV || 'development') === 'production';

  if (!secret) {
    if (isProduction) {
      res.status(404).json({ success: false, message: 'Not found' });
      return false;
    }
    return true;
  }

  const provided = String(
    req.headers['x-setup-secret'] || req.query.secret || ''
  ).trim();

  if (!provided || provided.length !== secret.length) {
    res.status(403).json({ success: false, message: 'Accès refusé' });
    return false;
  }

  const ok = crypto.timingSafeEqual(
    Buffer.from(provided),
    Buffer.from(secret)
  );
  if (!ok) {
    res.status(403).json({ success: false, message: 'Accès refusé' });
    return false;
  }
  return true;
}
