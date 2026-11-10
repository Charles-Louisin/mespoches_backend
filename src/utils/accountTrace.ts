import crypto from 'crypto';
import type { Request } from 'express';
import AccountTrace, { type TraceKind } from '../models/AccountTrace';
import { getNewUserTrialFields } from './subscription';

/**
 * Anti-abus de l'essai gratuit : supprimer puis recréer un compte ne rouvre pas l'essai.
 * On garde, après suppression, des empreintes HMAC (non réversibles) de l'email normalisé,
 * de l'identifiant Google et de la clé d'installation de l'app.
 *
 * ⚠️ ACCOUNT_TRACE_SECRET ne doit jamais changer (sinon les traces existantes ne correspondent plus).
 * À défaut, JWT_SECRET est utilisé.
 */
export interface IdentityHints {
  email?: string | null;
  googleId?: string | null;
  deviceKey?: string | null;
}

function traceSecret(): string {
  const secret = (process.env.ACCOUNT_TRACE_SECRET || process.env.JWT_SECRET || '').trim();
  if (!secret) throw new Error('ACCOUNT_TRACE_SECRET (ou JWT_SECRET) requis');
  return secret;
}

/**
 * Email canonique : minuscules, sans « +alias », et sans points pour Gmail
 * (j.doe+test@gmail.com, jdoe@googlemail.com → jdoe@gmail.com).
 */
export function canonicalEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

function hashOf(kind: TraceKind, value: string): string {
  return crypto.createHmac('sha256', traceSecret()).update(`${kind}:${value}`).digest('hex');
}

const DEVICE_KEY_RE = /^[a-f0-9-]{16,64}$/i;

/** Clé d'installation envoyée par l'app (en-tête X-Device-Key), validée. */
export function deviceKeyFrom(req: Request): string | null {
  const raw = String(req.headers['x-device-key'] || '').trim();
  return DEVICE_KEY_RE.test(raw) ? raw.toLowerCase() : null;
}

function tracesFor(hints: IdentityHints): { kind: TraceKind; hash: string }[] {
  const out: { kind: TraceKind; hash: string }[] = [];
  if (hints.email) out.push({ kind: 'email', hash: hashOf('email', canonicalEmail(hints.email)) });
  if (hints.googleId) out.push({ kind: 'google', hash: hashOf('google', String(hints.googleId)) });
  if (hints.deviceKey) out.push({ kind: 'device', hash: hashOf('device', hints.deviceKey) });
  return out;
}

/** Vrai si une de ces identités a déjà reçu l'essai gratuit (compte supprimé ou non). */
export async function hasUsedTrialBefore(hints: IdentityHints): Promise<boolean> {
  const traces = tracesFor(hints);
  if (!traces.length) return false;
  const found = await AccountTrace.exists({
    $or: traces.map((t) => ({ kind: t.kind, hash: t.hash })),
    trialGrantedAt: { $ne: null },
  });
  return Boolean(found);
}

async function upsert(hints: IdentityHints, update: Record<string, unknown>): Promise<void> {
  const now = new Date();
  await Promise.all(
    tracesFor(hints).map((t) =>
      AccountTrace.updateOne(
        { kind: t.kind, hash: t.hash },
        { $setOnInsert: { firstSeenAt: now }, $set: { lastSeenAt: now }, ...update },
        { upsert: true }
      ).catch((err) => console.error('AccountTrace upsert:', err instanceof Error ? err.message : err))
    )
  );
}

/** Fige la date d'essai sur les traces qui n'en ont pas encore. */
async function markTrial(hints: IdentityHints): Promise<void> {
  const traces = tracesFor(hints);
  if (!traces.length) return;
  await AccountTrace.updateMany(
    { $or: traces.map((t) => ({ kind: t.kind, hash: t.hash })), trialGrantedAt: null },
    { $set: { trialGrantedAt: new Date() } }
  ).catch((err) => console.error('AccountTrace trial:', err instanceof Error ? err.message : err));
}

/** Mémorise qu'un compte vient d'être ouvert (et si l'essai a été accordé). */
export async function recordAccountOpened(hints: IdentityHints, trialGranted: boolean): Promise<void> {
  await upsert(hints, { $inc: { accountsCreated: 1 } });
  if (trialGranted) await markTrial(hints);
}

/** Mémorise une identité déjà connue (connexion d'un compte existant) sans rien accorder. */
export async function touchIdentity(hints: IdentityHints, hadTrial: boolean): Promise<void> {
  await upsert(hints, {});
  if (hadTrial) await markTrial(hints);
}

/** À appeler AVANT de supprimer un compte : la trace reste en base. */
export async function recordAccountDeleted(hints: IdentityHints): Promise<void> {
  const now = new Date();
  await upsert(hints, { $inc: { deletedCount: 1 }, $set: { lastSeenAt: now, lastDeletedAt: now } });
  // Tout compte vérifié a reçu l'essai : on le fige même si la trace est antérieure à cette règle.
  await markTrial(hints);
}

/**
 * Champs d'abonnement d'un nouveau compte vérifié : essai Pro si l'identité est vraiment nouvelle,
 * sinon forfait gratuit (il faudra payer pour Premium).
 */
export async function startingPlanFor(
  hints: IdentityHints
): Promise<{ fields: Record<string, unknown>; trialGranted: boolean }> {
  const reused = await hasUsedTrialBefore(hints);
  if (reused) {
    return {
      trialGranted: false,
      fields: { plan: 'free', subscriptionTier: 'free', lifetime: false, premiumUntil: null, premiumSource: null },
    };
  }
  return { trialGranted: true, fields: getNewUserTrialFields() };
}
