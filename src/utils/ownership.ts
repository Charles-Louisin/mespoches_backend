import { Types } from 'mongoose';
import Category from '../models/Category';

/**
 * Vérifie qu'une catégorie appartient à l'utilisateur.
 * Retourne l'id normalisé, ou null si vide / invalide pour cet utilisateur.
 */
export async function resolveOwnedCategoryId(
  userId: Types.ObjectId | string,
  categoryId: string | null | undefined
): Promise<string | null> {
  if (categoryId === undefined || categoryId === null || categoryId === '') {
    return null;
  }
  const found = await Category.findOne({
    _id: categoryId,
    user_id: userId,
  })
    .select('_id')
    .lean();
  if (!found) {
    throw new Error('Catégorie introuvable');
  }
  return String(found._id);
}
