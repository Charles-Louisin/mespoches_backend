import JobLock from '../models/JobLock';

/** Verrou Mongo partagé entre instances (évite un double cron). */
export async function acquireJobLock(
  name: string,
  ttlMs: number
): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const owner = `${process.pid}-${now.getTime()}`;

  try {
    await JobLock.updateOne(
      {
        _id: name,
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $lte: now } }],
      },
      { $set: { owner, expiresAt } },
      { upsert: true }
    );
    return true;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 11000) return false;
    throw err;
  }
}

export function parseListLimit(
  raw: unknown,
  fallback: number,
  max: number
): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}
