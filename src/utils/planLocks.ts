import { Response } from 'express';
import { Types } from 'mongoose';
import Category from '../models/Category';
import Wallet from '../models/Wallet';
import type { IUser } from '../models/User';
import { TIER_DEFS, nextTier, priceFor, QUOTA_REACHED_CODE } from '../config/planLimits';
import { accessTier } from './subscription';
import { sendLimitError } from '../middleware/auth';

/**
 * Poches et catégories au-delà du palier actuel.
 *
 * Rien n'est supprimé quand le forfait baisse : les N plus anciennes (N = limite du palier)
 * restent utilisables, les suivantes sont « verrouillées » (visibles, grisées, inutilisables
 * pour une nouvelle opération) jusqu'au passage à un palier qui les couvre.
 */
export type LockKind = 'wallets' | 'categories';

const LABEL: Record<LockKind, { one: string; many: string }> = {
  wallets: { one: 'Cette poche', many: 'poches' },
  categories: { one: 'Cette catégorie', many: 'catégories' },
};

export function capFor(user: IUser, kind: LockKind): number | null {
  const def = TIER_DEFS[accessTier(user)];
  return kind === 'wallets' ? def.wallets : def.categories;
}

/** Ids verrouillés pour ce palier (ensemble vide si le palier couvre tout). */
export async function lockedIdsFor(user: IUser, kind: LockKind): Promise<Set<string>> {
  const cap = capFor(user, kind);
  if (cap == null) return new Set();
  const filter =
    kind === 'wallets'
      ? { user_id: user._id, is_deleted: { $ne: true } }
      : { user_id: user._id };
  const Model = (kind === 'wallets' ? Wallet : Category) as unknown as typeof Category;
  // Ordre de création stable : les plus anciennes restent ouvertes.
  const extra = await Model.find(filter)
    .sort({ created_at: 1, _id: 1 })
    .skip(cap)
    .select('_id')
    .lean();
  return new Set(extra.map((d) => String(d._id)));
}

function idOf(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'object' && v !== null && '_id' in (v as object)) return String((v as { _id: unknown })._id);
  const s = String(v);
  return Types.ObjectId.isValid(s) ? s : '';
}

export type LockViolation = {
  kind: LockKind;
  message: string;
  data: {
    resource: LockKind;
    locked: true;
    limit: number;
    tier: string;
    tierLabel: string;
    nextTier: string | null;
    nextLabel: string | null;
    nextLimit: number | null;
    nextPriceXaf: number | null;
  };
};

function violation(user: IUser, kind: LockKind): LockViolation {
  const tier = accessTier(user);
  const limit = capFor(user, kind) ?? 0;
  const upcoming = nextTier(tier);
  const nextLimit = upcoming ? (kind === 'wallets' ? TIER_DEFS[upcoming].wallets : TIER_DEFS[upcoming].categories) : null;
  const upgrade = upcoming
    ? ` Passez au palier ${TIER_DEFS[upcoming].label} pour la réutiliser.`
    : '';
  return {
    kind,
    message: `${LABEL[kind].one} n’est plus incluse dans le plan ${TIER_DEFS[tier].label} (${limit} ${LABEL[kind].many} au maximum).${upgrade}`,
    data: {
      resource: kind,
      locked: true,
      limit,
      tier,
      tierLabel: TIER_DEFS[tier].label,
      nextTier: upcoming,
      nextLabel: upcoming ? TIER_DEFS[upcoming].label : null,
      nextLimit,
      nextPriceXaf: upcoming ? priceFor(upcoming, 'monthly') : null,
    },
  };
}

/** Première poche ou catégorie verrouillée parmi celles demandées, sinon null. */
export async function findLockViolation(
  user: IUser,
  ids: { wallets?: unknown[]; categories?: unknown[] }
): Promise<LockViolation | null> {
  const wallets = (ids.wallets || []).map(idOf).filter(Boolean);
  const categories = (ids.categories || []).map(idOf).filter(Boolean);
  if (wallets.length) {
    const locked = await lockedIdsFor(user, 'wallets');
    if (wallets.some((id) => locked.has(id))) return violation(user, 'wallets');
  }
  if (categories.length) {
    const locked = await lockedIdsFor(user, 'categories');
    if (categories.some((id) => locked.has(id))) return violation(user, 'categories');
  }
  return null;
}

/** Répond 403 (code QUOTA_REACHED, l'app propose le palier supérieur) si une ressource est verrouillée. */
export async function rejectIfLocked(
  res: Response,
  user: IUser,
  ids: { wallets?: unknown[]; categories?: unknown[] }
): Promise<boolean> {
  const v = await findLockViolation(user, ids);
  if (!v) return false;
  sendLimitError(res, v.message, { code: QUOTA_REACHED_CODE, data: v.data });
  return true;
}
