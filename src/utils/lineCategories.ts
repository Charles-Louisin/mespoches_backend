import { Types } from 'mongoose';
import Category from '../models/Category';

/**
 * Valide la catégorie de chaque ligne : elle doit appartenir à l'utilisateur ET être du type de la
 * transaction (pas de catégorie « revenu » sur une ligne de dépense). Sinon → null (= catégorie de la transaction).
 * Une seule requête pour toutes les lignes.
 */
export async function withLineCategories<T extends { category_id?: unknown }>(
  userId: Types.ObjectId,
  type: 'income' | 'expense',
  items: T[]
): Promise<Array<T & { category_id: Types.ObjectId | null }>> {
  const raw = items.map((i) => {
    const v = i.category_id;
    const id = v && typeof v === 'object' && '_id' in (v as object) ? String((v as { _id: unknown })._id) : v ? String(v) : '';
    return Types.ObjectId.isValid(id) && id.length === 24 ? id : '';
  });
  const wanted = [...new Set(raw.filter(Boolean))];
  const owned = wanted.length
    ? await Category.find({ _id: { $in: wanted }, user_id: userId, type }).select('_id').lean()
    : [];
  const ok = new Set(owned.map((c) => String(c._id)));
  return items.map((item, idx) => ({
    ...item,
    category_id: raw[idx] && ok.has(raw[idx]) ? new Types.ObjectId(raw[idx]) : null,
  }));
}
