import { Router, Request, Response } from 'express';
import type { IUser } from '../models/User';
import Transaction from '../models/Transaction';
import { protect, premiumOnly, sendLimitError } from '../middleware/auth';
import { canExportRange, exportFormatDenied } from '../utils/subscription';
import { exportLimiter } from '../utils/security';
import {
  buildSingleTransactionCsv,
  buildTransactionsCsv,
  buildTransactionPdf,
  buildTransactionsPdf,
  buildTransactionsXlsx,
  buildSingleTransactionXlsx,
  exportFileBase,
  type ExportContext,
  PopulatedTransactionLike,
} from '../utils/transactionExport';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const router = Router();
const EXPORT_MAX_ROWS = 2000;

const listQuery = {
  $or: [
    { type: { $ne: 'transfer' } },
    { type: 'transfer', is_transfer_mirror: { $ne: true } },
  ],
};

function sendFile(
  res: Response,
  buffer: string | Buffer,
  filename: string,
  contentType: string
): void {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

const YMD = /^d{4}-d{2}-d{2}$/;

/** Fuseau de l'utilisateur (envoyé par l'app) ; Afrique centrale par défaut. */
function timeZoneOf(raw: unknown): string {
  const tz = String(raw || '').trim();
  if (tz && tz.length <= 64) {
    try {
      new Intl.DateTimeFormat('fr-FR', { timeZone: tz });
      return tz;
    } catch {
      /* fuseau inconnu */
    }
  }
  return 'Africa/Douala';
}

function exportContext(req: Request, period?: { from: string | null; to: string | null }): ExportContext {
  const user = req.user!;
  return {
    holderName: user.name || '',
    holderEmail: user.email,
    currency: user.currency || 'XAF',
    timeZone: timeZoneOf(req.query.tz),
    from: period?.from ?? null,
    to: period?.to ?? null,
    generatedAt: new Date(),
  };
}

/** Période affichée dans le titre : dates locales choisies dans l'app (fin incluse). */
function requestedPeriod(req: Request, since: Date | null): { from: string | null; to: string | null } {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (YMD.test(from) && YMD.test(to) && from <= to) return { from, to };
  if (since) {
    const tz = timeZoneOf(req.query.tz);
    const fmt = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    return { from: fmt(since), to: fmt(new Date()) };
  }
  return { from: null, to: null };
}

function withDetails<T>(query: T): T {
  const q = query as unknown as {
    populate: (path: string | Record<string, unknown>, select?: string) => unknown;
  };
  q.populate('wallet_id', 'name');
  q.populate('destination_wallet_id', 'name');
  q.populate('category_id', 'name');
  q.populate('savings_goal_id', 'title');
  q.populate({ path: 'line_items.category_id', select: 'name' });
  return query;
}

async function getUserTransaction(
  userId: import('mongoose').Types.ObjectId,
  id: string
) {
  return withDetails(Transaction.findOne({ _id: id, user_id: userId }));
}

function exportSince(user: IUser, raw: unknown): Date | null {
  if (!user || !canExportRange(user)) return null;
  const days = Math.min(3660, Math.max(0, parseInt(String(raw || ''), 10) || 0));
  if (!days) return null;
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));
  return since;
}

const MAX_RANGE_MS = 32 * 24 * 60 * 60 * 1000;
const MAX_RANGES = 800;

/** Plages explicites (début inclus, fin exclue) choisies depuis l'inscription. */
function exportRanges(user: IUser, raw: unknown): { date: { $gte: Date; $lt: Date } }[] | 'invalid' | null {
  if (!user || !canExportRange(user)) return null;
  const text = String(raw || '').trim();
  if (!text) return null;
  const parts = text.split(',').map((part) => part.trim()).filter(Boolean).slice(0, MAX_RANGES);
  const ranges: { date: { $gte: Date; $lt: Date } }[] = [];
  for (const part of parts) {
    const [fromRaw, toRaw] = part.split('..');
    const start = new Date(fromRaw || '');
    const end = new Date(toRaw || '');
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (end.getTime() <= start.getTime()) continue;
    if (end.getTime() - start.getTime() > MAX_RANGE_MS) continue;
    ranges.push({ date: { $gte: start, $lt: end } });
  }
  return ranges.length ? ranges : 'invalid';
}

router.get('/transactions', protect, premiumOnly, exportLimiter, async (req: Request, res: Response) => {
  try {
    const format = (req.query.format as string) || 'csv';
    const denied = exportFormatDenied(req.user!, format);
    if (denied) {
      return sendLimitError(res, denied.message, { code: denied.code, data: denied.data });
    }
    const ranges = exportRanges(req.user!, req.query.ranges);
    if (ranges === 'invalid') {
      return res.status(400).json({
        success: false,
        message: 'Choisissez au moins une période valide.',
      });
    }
    const since = ranges ? null : exportSince(req.user!, req.query.days);
    const dateClause = ranges
      ? { $or: ranges }
      : since
        ? { date: { $gte: since } }
        : null;

    // Ordre chronologique (du plus ancien au plus récent) : lecture naturelle d'un relevé.
    const transactions = await withDetails(
      Transaction.find({
        user_id: req.user!._id,
        $and: [listQuery, ...(dateClause ? [dateClause] : [])],
      })
        .sort({ date: 1, created_at: 1 })
        .limit(EXPORT_MAX_ROWS)
    ).lean();

    const rows = transactions as unknown as PopulatedTransactionLike[];
    const ctx = exportContext(req, requestedPeriod(req, since));
    const base = exportFileBase(ctx, rows);

    if (format === 'pdf') {
      return sendFile(res, await buildTransactionsPdf(rows, ctx), `${base}.pdf`, 'application/pdf');
    }
    if (format === 'xlsx') {
      return sendFile(res, await buildTransactionsXlsx(rows, ctx), `${base}.xlsx`, XLSX_MIME);
    }
    return sendFile(res, buildTransactionsCsv(rows, ctx), `${base}.csv`, 'text/csv; charset=utf-8');
  } catch (error) {
    console.error('Erreur export:', error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de l'export",
    });
  }
});

router.get('/transactions/:id', protect, premiumOnly, exportLimiter, async (req: Request, res: Response) => {
  try {
    const format = (req.query.format as string) || 'csv';
    const denied = exportFormatDenied(req.user!, format);
    if (denied) {
      return sendLimitError(res, denied.message, { code: denied.code, data: denied.data });
    }
    const transaction = await getUserTransaction(req.user!._id, req.params.id);

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction introuvable',
      });
    }

    const row = transaction.toObject() as unknown as PopulatedTransactionLike;
    const ctx = exportContext(req);
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: ctx.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(transaction.date));
    const base = `mes-poches-operation-${day}-${String(transaction._id).slice(-6)}`;

    if (format === 'pdf') {
      return sendFile(res, await buildTransactionPdf(row, ctx), `${base}.pdf`, 'application/pdf');
    }
    if (format === 'xlsx') {
      return sendFile(res, await buildSingleTransactionXlsx(row, ctx), `${base}.xlsx`, XLSX_MIME);
    }
    return sendFile(res, buildSingleTransactionCsv(row, ctx), `${base}.csv`, 'text/csv; charset=utf-8');
  } catch (error) {
    console.error('Erreur export transaction:', error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de l'export",
    });
  }
});

export default router;
