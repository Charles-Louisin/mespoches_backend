import { Types } from 'mongoose';
import Category from '../models/Category';

/**
 * Catégories de l'utilisateur, séparées par type, pour guider l'IA (scan photo, note vocale)
 * puis rattacher chaque bloc de transactions à une vraie catégorie du compte.
 */
export type CategoryRef = { id: Types.ObjectId; name: string };
export type CategoryCatalog = { expense: CategoryRef[]; income: CategoryRef[] };

export async function getCategoryCatalog(userId: Types.ObjectId): Promise<CategoryCatalog> {
  const cats = await Category.find({ user_id: userId }).select('name type').lean();
  const catalog: CategoryCatalog = { expense: [], income: [] };
  for (const c of cats) {
    const name = String(c.name || '').trim();
    if (!name) continue;
    if (c.type === 'income') catalog.income.push({ id: c._id as Types.ObjectId, name });
    else if (c.type === 'expense') catalog.expense.push({ id: c._id as Types.ObjectId, name });
  }
  return catalog;
}

/** Minuscules, sans accents ni ponctuation : « Électricité / Eau » ≈ « electricite eau ». */
export function normalizeLabel(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Retrouve la catégorie du compte correspondant au nom renvoyé par l'IA, dans le BON type uniquement
 * (une catégorie de dépense n'est jamais attribuée à un revenu). Exact, puis inclusion.
 */
export function matchCatalogCategory(
  catalog: CategoryCatalog,
  type: 'income' | 'expense',
  name: string | null | undefined
): CategoryRef | null {
  if (!name?.trim()) return null;
  const list = catalog[type];
  const n = normalizeLabel(name);
  if (!n) return null;
  const exact = list.find((c) => normalizeLabel(c.name) === n);
  if (exact) return exact;
  const partial = list.find((c) => {
    const cn = normalizeLabel(c.name);
    return cn.length >= 3 && (cn.includes(n) || n.includes(cn));
  });
  return partial ?? null;
}

/** Bloc texte (donnée) listant les catégories, inséré dans les prompts. */
export function catalogForPrompt(catalog: CategoryCatalog): string {
  const fmt = (list: CategoryRef[]) => (list.length ? list.map((c) => `- ${c.name}`).join('\n') : '(aucune)');
  return `Catégories de DÉPENSE du compte :\n${fmt(catalog.expense)}\n\nCatégories de REVENU du compte :\n${fmt(catalog.income)}`;
}
