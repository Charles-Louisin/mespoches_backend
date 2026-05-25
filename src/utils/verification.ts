import User, { IUser } from '../models/User';
import { generateVerificationCode, sendVerificationEmail } from './email';

export const CODE_EXPIRY_MINUTES = 15;
export const RESEND_COOLDOWN_MS = 60_000;

export async function setVerificationCode(user: IUser): Promise<string> {
  const code = generateVerificationCode();
  user.verificationCode = code;
  user.verificationCodeExpires = new Date(
    Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000
  );
  user.lastVerificationSentAt = new Date();
  await user.save();
  await sendVerificationEmail(user.email, code);
  return code;
}

export async function verifyCode(
  user: IUser,
  code: string
): Promise<boolean> {
  if (!user.verificationCode || !user.verificationCodeExpires) {
    return false;
  }
  if (user.verificationCodeExpires < new Date()) {
    return false;
  }
  return user.verificationCode === code.trim();
}

export function getResendCooldownSeconds(user: IUser): number {
  if (!user.lastVerificationSentAt) return 0;
  const elapsed = Date.now() - user.lastVerificationSentAt.getTime();
  const remaining = RESEND_COOLDOWN_MS - elapsed;
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}
