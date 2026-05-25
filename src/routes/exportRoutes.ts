import { Router, Request, Response } from 'express';
import Transaction from '../models/Transaction';
import { protect, premiumOnly } from '../middleware/auth';
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
    .populate('wallet_id')
    .populate('destination_wallet_id')
    .populate('category_id');
}

router.get('/transactions', protect, premiumOnly, async (req: Request, res: Response) => {
  try {
    const format = (req.query.format as string) || 'csv';

    const transactions = await Transaction.find({
      user_id: req.user!._id,
      ...listQuery,
    })
      .populate('wallet_id')
      .populate('destination_wallet_id')
      .populate('category_id')
      .sort({ date: -1 });

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

router.get('/transactions/:id', protect, premiumOnly, async (req: Request, res: Response) => {
  try {
    const format = (req.query.format as string) || 'csv';
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
