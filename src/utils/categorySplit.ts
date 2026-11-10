import type { PipelineStage } from 'mongoose';

/**
 * Étapes d'agrégation qui « éclatent » une transaction par catégorie de ligne.
 * - Si au moins une ligne (line_items) porte une catégorie, chaque ligne compte dans SA catégorie
 *   (à défaut, dans celle de la transaction).
 * - Sinon, la transaction compte entière dans sa catégorie (comportement historique).
 * Produit des documents { part: { cat, amount }, ... } à regrouper ensuite par `$part.cat`.
 */
export function categorySplitStages(): PipelineStage[] {
  return [
    {
      $addFields: {
        __hasLineCats: {
          $gt: [
            {
              $size: {
                $filter: {
                  input: { $ifNull: ['$line_items', []] },
                  as: 'l',
                  cond: { $ne: [{ $ifNull: ['$$l.category_id', null] }, null] },
                },
              },
            },
            0,
          ],
        },
      },
    },
    {
      $addFields: {
        __parts: {
          $cond: [
            '$__hasLineCats',
            {
              $map: {
                input: '$line_items',
                as: 'l',
                in: { cat: { $ifNull: ['$$l.category_id', '$category_id'] }, amount: '$$l.amount' },
              },
            },
            [{ cat: '$category_id', amount: '$amount' }],
          ],
        },
      },
    },
    { $unwind: '$__parts' },
    { $match: { '__parts.cat': { $ne: null } } },
  ];
}

/** Filtre de première étape : la transaction OU une de ses lignes est dans ces catégories. */
export function matchCategoryOrLines(ids: unknown[]): Record<string, unknown> {
  return { $or: [{ category_id: { $in: ids } }, { 'line_items.category_id': { $in: ids } }] };
}
