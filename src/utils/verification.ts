import crypto from 'crypto';
import { IUser } from '../models/User';
import { sendVerificationEmail } from './email';
import {
  generateSecureOtp,
  hashOtp,
  timingSafeEqualHex,
} from './security';

function timingSafeEqualUtf8(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export const CODE_EXPIRY_MINUTES = 15;
export const RESEND_COOLDOWN_MS = 60_000;
export const MAX_OTP_ATTEMPTS = 5;

export async function setVerificationCode(user: IUser): Promise<void> {
  const code = generateSecureOtp();
  user.verificationCode = hashOtp(code);
  user.verificationCodeExpires = new Date(
    Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000
  );
  user.lastVerificationSentAt = new Date();
  user.verificationAttempts = 0;
  await user.save();
  await sendVerificationEmail(user.email, code);
}

export async function verifyCode(
  user: IUser,
  code: string
): Promise<'ok' | 'invalid' | 'locked'> {
  if ((user.verificationAttempts ?? 0) >= MAX_OTP_ATTEMPTS) {
    return 'locked';
  }
  if (!user.verificationCode || !user.verificationCodeExpires) {
    return 'invalid';
  }
  if (user.verificationCodeExpires < new Date()) {
    return 'invalid';
  }

  const candidate = hashOtp(code);
  const stored = String(user.verificationCode);
  // Codes historiques en clair (avant hash HMAC) — compat temporaire
  const match =
    timingSafeEqualHex(candidate, stored) ||
    (stored.length === 6 &&
      /^\d{6}$/.test(stored) &&
      timingSafeEqualUtf8(stored, code.trim()));

  if (!match) {
    user.verificationAttempts = (user.verificationAttempts ?? 0) + 1;
    await user.save();
    if ((user.verificationAttempts ?? 0) >= MAX_OTP_ATTEMPTS) {
      return 'locked';
    }
    return 'invalid';
  }

  user.verificationAttempts = 0;
  return 'ok';
}

export function getResendCooldownSeconds(user: IUser): number {
  if (!user.lastVerificationSentAt) return 0;
  const elapsed = Date.now() - user.lastVerificationSentAt.getTime();
  const remaining = RESEND_COOLDOWN_MS - elapsed;
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}
