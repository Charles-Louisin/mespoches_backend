import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { Request } from 'express';

/** Clé IP stable derrière proxy (Render, ngrok, etc.). */
export function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return String(forwarded[0]).trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

const rateLimitBase = {
  standardHeaders: true as const,
  legacyHeaders: false as const,
  validate: { xForwardedForHeader: false },
};

export const authIpLimiter = rateLimit({
  ...rateLimitBase,
  windowMs: 15 * 60 * 1000,
  max: 40,
  keyGenerator: (req) => `auth-ip:${clientIp(req)}`,
  message: {
    success: false,
    code: 'RATE_LIMITED',
    message: 'Trop de tentatives. Réessayez plus tard.',
  },
});

export const loginLimiter = rateLimit({
  ...rateLimitBase,
  windowMs: 15 * 60 * 1000,
  max: 15,
  keyGenerator: (req) => {
    const email =
      typeof req.body?.email === 'string'
        ? req.body.email.trim().toLowerCase()
        : '';
    return `login:${clientIp(req)}:${email}`;
  },
  message: {
    success: false,
    code: 'RATE_LIMITED',
    message: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.',
  },
});

export const otpLimiter = rateLimit({
  ...rateLimitBase,
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => {
    const email =
      typeof req.body?.email === 'string'
        ? req.body.email.trim().toLowerCase()
        : '';
    return `otp:${clientIp(req)}:${email}`;
  },
  message: {
    success: false,
    code: 'RATE_LIMITED',
    message: 'Trop de tentatives de vérification. Réessayez plus tard.',
  },
});

export const availabilityLimiter = rateLimit({
  ...rateLimitBase,
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => `avail:${clientIp(req)}`,
  message: {
    success: false,
    code: 'RATE_LIMITED',
    message: 'Trop de requêtes. Réessayez plus tard.',
  },
});

export const aiScanLimiter = rateLimit({
  ...rateLimitBase,
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => {
    const uid = req.user?._id ? String(req.user._id) : clientIp(req);
    return `ai-scan:${uid}`;
  },
  message: {
    success: false,
    code: 'RATE_LIMITED',
    message: 'Quota de scans IA atteint. Réessayez dans une heure.',
  },
});

export function escapeHtml(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function hashOtp(code: string): string {
  const pepper = process.env.JWT_SECRET || 'mes-poches-otp';
  return crypto.createHmac('sha256', pepper).update(code.trim()).digest('hex');
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export function generateSecureOtp(): string {
  return crypto.randomInt(100000, 1000000).toString();
}
