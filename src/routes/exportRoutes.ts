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

async function getUserTransaction(
  userId: import('mongoose').Types.ObjectId,
  id: string
) {
  return Transaction.findOne({ _id: id, user_id: userId })
    .populate('wallet_id', 'name')
    .populate('destination_wallet_id', 'name')
    .populate('category_id', 'name');
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

    const transactions = await Transaction.find({
      user_id: req.user!._id,
      $and: [listQuery, ...(dateClause ? [dateClause] : [])],
    })
      .populate('wallet_id', 'name')
      .populate('destination_wallet_id', 'name')
      .populate('category_id', 'name')
      .sort({ date: -1 })
      .limit(EXPORT_MAX_ROWS);

    const rows = transactions as unknown as PopulatedTransactionLike[];
    const stamp = Date.now();

    if (format === 'pdf') {
      const pdf = await buildTransactionsPdf(rows);
      return sendFile(
        res,
        pdf,
        `mes-poches-transactions-${stamp}.pdf`,
        'application/pdf'
      );
    }

    if (format === 'xlsx') {
      const xlsx = buildTransactionsXlsx(rows);
      return sendFile(
        res,
        xlsx,
        `mes-poches-transactions-${stamp}.xlsx`,
        XLSX_MIME
      );
    }

    const csv = buildTransactionsCsv(rows);
    return sendFile(res, csv, `mes-poches-transactions-${stamp}.csv`, 'text/csv; charset=utf-8');
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

    const row = transaction as unknown as PopulatedTransactionLike;
    const stamp = Date.now();
    const shortId = String(transaction._id).slice(-8);

    let transferFrom: string | undefined;
    let transferTo: string | undefined;
    if (transaction.type === 'transfer') {
      const w = transaction.wallet_id as { name?: string } | null;
      const d = transaction.destination_wallet_id as { name?: string } | null;
      transferFrom = w?.name;
      transferTo = d?.name;
    }

    if (format === 'pdf') {
      const pdf = await buildTransactionPdf(row, { transferFrom, transferTo });
      return sendFile(
        res,
        pdf,
        `transaction-${shortId}-${stamp}.pdf`,
        'application/pdf'
      );
    }

    if (format === 'xlsx') {
      const xlsx = buildSingleTransactionXlsx(row);
      return sendFile(
        res,
        xlsx,
        `transaction-${shortId}-${stamp}.xlsx`,
        XLSX_MIME
      );
    }

    const csv = buildSingleTransactionCsv(row);
    return sendFile(res, csv, `transaction-${shortId}-${stamp}.csv`, 'text/csv; charset=utf-8');
  } catch (error) {
    console.error('Erreur export transaction:', error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de l'export",
    });
  }
});

export default router;
