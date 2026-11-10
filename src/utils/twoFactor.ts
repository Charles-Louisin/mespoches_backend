import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { IUser } from '../models/User';
import { sendTwoFactorEmail, type TwoFactorPurpose } from './email';
import { generateSecureOtp, hashOtp, timingSafeEqualHex } from './security';

/**
 * Double authentification par e-mail.
 * - Connexion par mot de passe sur un appareil non approuvé → code à 6 chiffres envoyé par e-mail.
 * - « Faire confiance à cet appareil » : jeton aléatoire 30 jours ; seule son empreinte SHA-256 est stockée.
 * Les champs twoFactor* et trustedDevices doivent être chargés avec .select('+…').
 */
export const TWO_FACTOR_SELECT = '+twoFactorCode +twoFactorExpires +twoFactorAttempts +twoFactorSentAt +trustedDevices';
const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;
const TRUST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TRUSTED_DEVICES = 5;
const CHALLENGE_TTL = '10m';

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'•'.repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

export function twoFactorCooldownSeconds(user: IUser): number {
  if (!user.twoFactorSentAt) return 0;
  const left = RESEND_COOLDOWN_MS - (Date.now() - new Date(user.twoFactorSentAt).getTime());
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/** Génère, enregistre (haché) et envoie un code. Respecte un délai de 30 s entre deux envois. */
export async function sendTwoFactorCode(user: IUser, purpose: TwoFactorPurpose): Promise<{ cooldownSeconds: number }> {
  const wait = twoFactorCooldownSeconds(user);
  if (wait > 0) return { cooldownSeconds: wait };
  const code = generateSecureOtp();
  user.twoFactorCode = hashOtp(`${purpose}:${code}`);
  user.twoFactorExpires = new Date(Date.now() + CODE_TTL_MS);
  user.twoFactorAttempts = 0;
  user.twoFactorSentAt = new Date();
  await user.save();
  await sendTwoFactorEmail(user.email, code, purpose);
  return { cooldownSeconds: Math.ceil(RESEND_COOLDOWN_MS / 1000) };
}

/** Vérifie un code (usage unique). Après 5 erreurs, le code est verrouillé jusqu'au prochain envoi. */
export async function checkTwoFactorCode(
  user: IUser,
  code: string,
  purpose: TwoFactorPurpose
): Promise<'ok' | 'invalid' | 'locked'> {
  if ((user.twoFactorAttempts ?? 0) >= MAX_ATTEMPTS) return 'locked';
  if (!user.twoFactorCode || !user.twoFactorExpires || user.twoFactorExpires < new Date()) return 'invalid';
  if (!/^\d{6}$/.test(code)) return 'invalid';
  const ok = timingSafeEqualHex(hashOtp(`${purpose}:${code}`), String(user.twoFactorCode));
  if (!ok) {
    user.twoFactorAttempts = (user.twoFactorAttempts ?? 0) + 1;
    await user.save();
    return (user.twoFactorAttempts ?? 0) >= MAX_ATTEMPTS ? 'locked' : 'invalid';
  }
  user.twoFactorCode = null;
  user.twoFactorExpires = null;
  user.twoFactorAttempts = 0;
  return 'ok';
}

/** Jeton d'étape intermédiaire (mot de passe validé, code attendu). Ne donne accès à aucune route. */
export function createLoginChallenge(user: IUser): string {
  return jwt.sign(
    { sub: String(user._id), purpose: '2fa-login', tv: user.tokenVersion ?? 0 },
    process.env.JWT_SECRET as string,
    { expiresIn: CHALLENGE_TTL }
  );
}

export function readLoginChallenge(token: string): { userId: string; tv: number } | null {
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET as string, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (p.purpose !== '2fa-login' || typeof p.sub !== 'string') return null;
    return { userId: p.sub, tv: Number(p.tv ?? 0) };
  } catch {
    return null;
  }
}

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

export function isTrustedDevice(user: IUser, token: string | undefined | null): boolean {
  if (!token || token.length < 32 || token.length > 128) return false;
  const h = sha256(token);
  const now = Date.now();
  return (user.trustedDevices ?? []).some(
    (d) => new Date(d.expiresAt).getTime() > now && timingSafeEqualHex(d.hash, h)
  );
}

/** Crée un jeton d'appareil approuvé (renvoyé une seule fois au client). */
export function addTrustedDevice(user: IUser): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const kept = (user.trustedDevices ?? []).filter((d) => new Date(d.expiresAt).getTime() > now);
  kept.push({ hash: sha256(token), createdAt: new Date(now), expiresAt: new Date(now + TRUST_TTL_MS) });
  user.trustedDevices = kept.slice(-MAX_TRUSTED_DEVICES);
  return token;
}

export function clearTwoFactorState(user: IUser): void {
  user.twoFactorCode = null;
  user.twoFactorExpires = null;
  user.twoFactorAttempts = 0;
  user.trustedDevices = [];
}
