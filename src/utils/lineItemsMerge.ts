import type { Types } from 'mongoose';

type LineType = 'income' | 'expense';

export interface StoredLine {
  description?: string;
  amount?: number;
  quantity?: number;
  unit_amount?: number;
  type?: LineType;
  category_id?: Types.ObjectId | string | null;
}

export interface IncomingLine {
  description?: string;
  amount?: number;
  quantity?: number;
  unit_amount?: number;
  type?: LineType;
  category_id?: unknown;
}

/**
 * Nouvelle liste de lignes à partir de celle envoyée par l'app (qui fait foi : ordre, suppressions,
 * libellés, montants). Une ligne sans catégorie fournie reprend celle de l'ancienne ligne de même libellé.
 */
export function mergeLineItems(
  existing: StoredLine[],
  incoming: IncomingLine[],
  withCats: { category_id?: Types.ObjectId | string | null }[],
  fallbackType: LineType
): StoredLine[] {
  const unused = [...existing];
  return incoming.map((item, idx) => {
    const description = String(item.description ?? '').trim();
    const matchIdx = unused.findIndex(
      (line) => String(line.description || '').trim().toLowerCase() === description.toLowerCase()
    );
    const prev = matchIdx >= 0 ? unused.splice(matchIdx, 1)[0] : undefined;
    const amount = Number(item.amount);
    const quantity = Number(item.quantity);
    const unit = Number(item.unit_amount);
    return {
      description: description || String(prev?.description || ''),
      amount: Number.isFinite(amount) && amount >= 0 ? amount : prev?.amount ?? 0,
      quantity: Number.isFinite(quantity) && quantity >= 1 ? quantity : 1,
      unit_amount: Number.isFinite(unit) && unit > 0 ? unit : undefined,
      type: item.type ?? prev?.type ?? fallbackType,
      category_id:
        item.category_id !== undefined ? withCats[idx]?.category_id ?? null : prev?.category_id ?? null,
    };
  });
}
