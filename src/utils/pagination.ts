import { parseListLimit } from './jobLock';

export { parseListLimit };

export type ListPage = {
  limit: number;
  skip: number;
  page: number;
};

/** page 1-based. skip/limit bornés pour éviter de charger des milliers de docs. */
export function parseListPage(
  query: { page?: unknown; limit?: unknown },
  fallbackLimit: number,
  maxLimit: number
): ListPage {
  const limit = parseListLimit(query.limit, fallbackLimit, maxLimit);
  const rawPage =
    typeof query.page === 'string' ? parseInt(query.page, 10) : Number(query.page);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(Math.floor(rawPage), 1000) : 1;
  return { limit, page, skip: (page - 1) * limit };
}

export function listMeta(page: ListPage, count: number, totalHint?: number) {
  const hasMore =
    typeof totalHint === 'number' ? page.skip + count < totalHint : count === page.limit;
  return {
    page: page.page,
    limit: page.limit,
    count,
    hasMore,
    ...(typeof totalHint === 'number' ? { total: totalHint } : {}),
  };
}
