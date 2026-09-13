import { Request, Response, NextFunction } from 'express';

/** Rejette les clés d’opérateur Mongo ($gt, $where, …) dans le JSON entrant. */
function stripOperatorKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripOperatorKeys);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith('$') || key.includes('.')) continue;
      out[key] = stripOperatorKeys(nested);
    }
    return out;
  }
  return value;
}

export function sanitizeMongoKeys(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (req.body && typeof req.body === 'object') {
    req.body = stripOperatorKeys(req.body);
  }
  next();
}
