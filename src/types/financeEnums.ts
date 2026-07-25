/** Enums partagés (IA JSON ↔ Mongo ↔ parsers). */

export const MOBILE_OPERATORS = ['orange', 'mtn', 'wave', 'bank', 'unknown'] as const
export type MobileOperator = (typeof MOBILE_OPERATORS)[number]

export const SMS_PATTERN_KINDS = [
  'transfer_out',
  'transfer_in',
  'payment',
  'withdrawal',
  'deposit',
  'unknown',
] as const
export type SmsPatternKind = (typeof SMS_PATTERN_KINDS)[number]

export const AI_DOCUMENT_TYPES = [
  'receipt',
  'invoice',
  'screenshot',
  'sms_mobile_money',
  'sms_bank',
  'handwritten_list',
  'handwritten_note',
  'other_financial',
] as const
export type AiDocumentType = (typeof AI_DOCUMENT_TYPES)[number]

export function isMobileOperator(v: unknown): v is MobileOperator {
  return typeof v === 'string' && (MOBILE_OPERATORS as readonly string[]).includes(v)
}

export function isSmsPatternKind(v: unknown): v is SmsPatternKind {
  return typeof v === 'string' && (SMS_PATTERN_KINDS as readonly string[]).includes(v)
}

export function isAiDocumentType(v: unknown): v is AiDocumentType {
  return typeof v === 'string' && (AI_DOCUMENT_TYPES as readonly string[]).includes(v)
}
