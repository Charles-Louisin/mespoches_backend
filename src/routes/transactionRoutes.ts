import { Router, Request, Response } from 'express';
import Joi from 'joi';
import mongoose, { FilterQuery, Types } from 'mongoose';
import Transaction, { ITransaction, TransactionType } from '../models/Transaction';
import Wallet from '../models/Wallet';
import SavingsGoal from '../models/SavingsGoal';
import { protect, sendLimitError } from '../middleware/auth';
import { isPremiumUser, getFreeHistoryStartDate } from '../utils/subscription';
import { allocateToSavingsGoal } from '../utils/savingsAllocation';
import { isFutureUtcDay } from '../utils/plannedExpenseDates';

const router = Router();

const baseSchema = {
  amount: Joi.number().positive().required(),
  wallet_id: Joi.string().required(),
  category_id: Joi.string().allow(null, ''),
  description: Joi.string().allow('', null),
  date: Joi.date().iso().optional(),
};

const incomeSchema = Joi.object({
  ...baseSchema,
  wallet_id: Joi.string().allow(null, ''),
  savings_goal_id: Joi.string().allow(null, ''),
});
const expenseSchema = Joi.object(baseSchema);
const transferSchema = Joi.object({
  amount: Joi.number().positive().required(),
  wallet_id: Joi.string().required(),
  destination_wallet_id: Joi.string().allow(null, ''),
  savings_goal_id: Joi.string().allow(null, ''),
  description: Joi.string().allow('', null),
  date: Joi.date().iso().optional(),
});

interface TransactionInput {
  amount: number;
  wallet_id: string;
  category_id?: string | null;
  description?: string | null;
  date?: Date;
  savings_goal_id?: string | null;
}

async function createTransactionAndUpdateWallet({
  userId,
  type,
  data,
}: {
  userId: Types.ObjectId;
  type: 'income' | 'expense';
  data: TransactionInput;
}): Promise<ITransaction> {
  const wallet = await Wallet.findOne({
    _id: data.wallet_id,
    user_id: userId,
    is_deleted: { $ne: true },
  });

  if (!wallet) {
    throw new Error('Portefeuille introuvable');
  }

  const balance_before = wallet.current_balance;
  let balance_after = balance_before;

  if (type === 'income') {
    balance_after = balance_before + data.amount;
  } else if (type === 'expense') {
    balance_after = balance_before - data.amount;
    if (balance_after < 0) {
      throw new Error('Solde insuffisant pour cette dépense');
    }
  }

  const transaction = await Transaction.create({
    user_id: userId,
    type,
    amount: data.amount,
    wallet_id: data.wallet_id,
    category_id: data.category_id || null,
    description: data.description || '',
    date: data.date || new Date(),
    balance_before,
    balance_after,
  });

  wallet.current_balance = balance_after;
  await wallet.save();

  return transaction;
}

async function reverseSimpleTransaction(
  transaction: ITransaction,
  userId: Types.ObjectId
): Promise<void> {
  if (transaction.savings_goal_id) {
    const goal = await SavingsGoal.findOne({
      _id: transaction.savings_goal_id,
      user_id: userId,
    });
    if (!goal) {
      throw new Error("Objectif d'épargne introuvable");
    }
    const newSaved = (goal.saved_amount ?? 0) - transaction.amount;
    if (newSaved < 0) {
      throw new Error(
        'Impossible de supprimer : montant déjà retiré de cet objectif'
      );
    }
    goal.saved_amount = newSaved;
    await goal.save();

    if (transaction.wallet_id && transaction.type === 'expense') {
      const wallet = await Wallet.findOne({
        _id: transaction.wallet_id,
        user_id: userId,
        is_deleted: { $ne: true },
      });
      if (!wallet) {
        throw new Error('Portefeuille introuvable');
      }
      wallet.current_balance += transaction.amount;
      await wallet.save();
    }
    return;
  }

  if (!transaction.wallet_id) {
    throw new Error('Transaction invalide');
  }

  const wallet = await Wallet.findOne({
    _id: transaction.wallet_id,
    user_id: userId,
    is_deleted: { $ne: true },
  });
  if (!wallet) {
    throw new Error('Portefeuille introuvable');
  }

  if (transaction.type === 'income') {
    wallet.current_balance -= transaction.amount;
    if (wallet.current_balance < 0) {
      throw new Error(
        'Impossible de supprimer : solde de la poche insuffisant'
      );
    }
  } else if (transaction.type === 'expense') {
    wallet.current_balance += transaction.amount;
  } else {
    throw new Error('Type de transaction non supporté');
  }

  await wallet.save();
}

async function deleteTransferGroup(
  base: ITransaction,
  userId: Types.ObjectId
): Promise<void> {
  let legs: ITransaction[] = [base];

  if (base.transfer_group_id) {
    legs = await Transaction.find({
      user_id: userId,
      transfer_group_id: base.transfer_group_id,
      type: 'transfer',
    });
  } else {
    const baseDate = new Date(base.date);
    const start = new Date(baseDate.getTime() - 2000);
    const end = new Date(baseDate.getTime() + 2000);

    const mirror = await Transaction.findOne({
      user_id: userId,
      type: 'transfer',
      amount: base.amount,
      date: { $gte: start, $lte: end },
      wallet_id: base.destination_wallet_id,
      destination_wallet_id: base.wallet_id,
      _id: { $ne: base._id },
    });

    if (mirror) {
      legs = [base, mirror];
    }
  }

  for (const leg of legs) {
    if (!leg.wallet_id) continue;

    const wallet = await Wallet.findOne({
      _id: leg.wallet_id,
      user_id: userId,
      is_deleted: { $ne: true },
    });
    if (!wallet) {
      throw new Error('Portefeuille introuvable');
    }

    if (leg.is_transfer_mirror) {
      wallet.current_balance -= leg.amount;
    } else {
      wallet.current_balance += leg.amount;
    }

    if (wallet.current_balance < 0) {
      throw new Error(
        'Impossible de supprimer : solde de la poche destination insuffisant'
      );
    }

    await wallet.save();
  }

  await Transaction.deleteMany({
    _id: { $in: legs.map((l) => l._id) },
    user_id: userId,
  });
}

router.get('/', protect, async (req: Request, res: Response) => {
  try {
    const { wallet_id, type, startDate, endDate } = req.query;
    const query: FilterQuery<ITransaction> = { user_id: req.user!._id };

    if (typeof wallet_id === 'string') {
      query.wallet_id = wallet_id;
    }
    if (typeof type === 'string') {
      query.type = type as TransactionType;
    }
    if (startDate || endDate || !isPremiumUser(req.user!)) {
      query.date = {};
      if (typeof startDate === 'string') query.date.$gte = new Date(startDate);
      if (typeof endDate === 'string') query.date.$lte = new Date(endDate);
      if (!isPremiumUser(req.user!)) {
        const cutoff = getFreeHistoryStartDate();
        query.date.$gte = query.date.$gte
          ? new Date(Math.max(query.date.$gte.getTime(), cutoff.getTime()))
          : cutoff;
      }
    }

    const transactions = await Transaction.find({
      ...query,
      $or: [
        { type: { $ne: 'transfer' } },
        { type: 'transfer', is_transfer_mirror: { $ne: true } },
      ],
    })
      .populate('wallet_id')
      .populate('destination_wallet_id')
      .populate('category_id')
      .populate('savings_goal_id')
      .sort({ date: -1 });

    const seenTransferKeys = new Set<string>();
    const filtered: ITransaction[] = [];

    for (const t of transactions) {
      if (t.type !== 'transfer') {
        filtered.push(t);
        continue;
      }

      if (t.transfer_group_id) {
        filtered.push(t);
        continue;
      }

      const dateSec = new Date(t.date).toISOString().slice(0, 19);
      const walletPop = t.wallet_id as { _id?: Types.ObjectId } | Types.ObjectId;
      const destPop = t.destination_wallet_id as
        | { _id?: Types.ObjectId }
        | Types.ObjectId
        | null;
      const w1 = String(
        (walletPop as { _id?: Types.ObjectId })?._id || walletPop
      );
      const w2 = String(
        (destPop as { _id?: Types.ObjectId })?._id || destPop || ''
      );
      const walletsKey = [w1, w2].sort().join('|');
      const key = `${dateSec}|${t.amount}|${walletsKey}`;

      if (seenTransferKeys.has(key)) continue;
      seenTransferKeys.add(key);
      filtered.push(t);
    }

    return res.json({
      success: true,
      count: filtered.length,
      data: filtered,
    });
  } catch (error) {
    console.error('Erreur get transactions:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des transactions',
    });
  }
});

router.get('/:id', protect, async (req: Request, res: Response) => {
  try {
    const transaction = await Transaction.findOne({
      _id: req.params.id,
      user_id: req.user!._id,
    })
      .populate('wallet_id')
      .populate('destination_wallet_id')
      .populate('category_id');

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction introuvable',
      });
    }

    return res.json({ success: true, data: transaction });
  } catch (error) {
    console.error('Erreur get transaction:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération de la transaction',
    });
  }
});

router.get('/:id/transfer-pair', protect, async (req: Request, res: Response) => {
  try {
    const base = await Transaction.findOne({
      _id: req.params.id,
      user_id: req.user!._id,
    });

    if (!base) {
      return res.status(404).json({
        success: false,
        message: 'Transaction introuvable',
      });
    }

    if (base.type !== 'transfer') {
      return res.status(400).json({
        success: false,
        message: "Cette transaction n'est pas un transfert",
      });
    }

    let pair: ITransaction[] = [];

    if (base.transfer_group_id) {
      pair = await Transaction.find({
        user_id: req.user!._id,
        transfer_group_id: base.transfer_group_id,
        type: 'transfer',
      })
        .populate('wallet_id')
        .populate('destination_wallet_id')
        .populate('category_id')
        .sort({ is_transfer_mirror: 1 });
    } else {
      const baseDate = new Date(base.date);
      const start = new Date(baseDate.getTime() - 2000);
      const end = new Date(baseDate.getTime() + 2000);

      const mirror = await Transaction.findOne({
        user_id: req.user!._id,
        type: 'transfer',
        amount: base.amount,
        date: { $gte: start, $lte: end },
        wallet_id: base.destination_wallet_id,
        destination_wallet_id: base.wallet_id,
        _id: { $ne: base._id },
      })
        .populate('wallet_id')
        .populate('destination_wallet_id')
        .populate('category_id');

      const populatedBase = await Transaction.findById(base._id)
        .populate('wallet_id')
        .populate('destination_wallet_id')
        .populate('category_id');

      pair = [populatedBase, mirror].filter(Boolean) as ITransaction[];
    }

    const debit =
      pair.find((t) => t.is_transfer_mirror !== true) || pair[0] || null;
    const credit =
      pair.find((t) => t.is_transfer_mirror === true) || pair[1] || null;

    return res.json({
      success: true,
      data: { debit, credit },
    });
  } catch (error) {
    console.error('Erreur get transfer pair:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération du transfert',
    });
  }
});

router.post('/income', protect, async (req: Request, res: Response) => {
  try {
    const { error, value } = incomeSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    if (value.savings_goal_id) {
      if (!isPremiumUser(req.user!)) {
        return sendLimitError(
          res,
          'L\'épargne est réservée aux abonnés Premium.',
          { premium: true }
        );
      }
      const transaction = await allocateToSavingsGoal({
        userId: req.user!._id,
        type: 'income',
        amount: value.amount,
        wallet_id: value.wallet_id || null,
        savings_goal_id: value.savings_goal_id,
        category_id: value.category_id,
        description: value.description,
        date: value.date,
      });
      const populated = await Transaction.findById(transaction._id)
        .populate('wallet_id')
        .populate('category_id')
        .populate('savings_goal_id');
      return res.status(201).json({ success: true, data: populated });
    }

    if (!value.wallet_id) {
      return res.status(400).json({
        success: false,
        message: 'Poche requise',
      });
    }

    const transaction = await createTransactionAndUpdateWallet({
      userId: req.user!._id,
      type: 'income',
      data: value,
    });

    const populated = await Transaction.findById(transaction._id)
      .populate('wallet_id')
      .populate('category_id')
      .populate('savings_goal_id');

    return res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error('Erreur income:', error);
    const message =
      error instanceof Error ? error.message : 'Erreur lors de la création du revenu';
    return res.status(400).json({ success: false, message });
  }
});

router.post('/expense', protect, async (req: Request, res: Response) => {
  try {
    const { error, value } = expenseSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    if (value.date && isFutureUtcDay(value.date)) {
      return res.status(400).json({
        success: false,
        message:
          'Pour une dépense future, enregistrez-la comme dépense prévue (date ultérieure en UTC).',
      });
    }

    const transaction = await createTransactionAndUpdateWallet({
      userId: req.user!._id,
      type: 'expense',
      data: value,
    });

    const populated = await Transaction.findById(transaction._id)
      .populate('wallet_id')
      .populate('category_id');

    return res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error('Erreur expense:', error);
    const message =
      error instanceof Error ? error.message : 'Erreur lors de la création de la dépense';
    return res.status(400).json({ success: false, message });
  }
});

router.post('/transfer', protect, async (req: Request, res: Response) => {
  try {
    if (!isPremiumUser(req.user!)) {
      return sendLimitError(
        res,
        'Les transferts entre poches sont réservés aux abonnés Premium.',
        { premium: true }
      );
    }

    const { error, value } = transferSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const toSavings = Boolean(value.savings_goal_id);
    const toWallet = Boolean(value.destination_wallet_id);
    if (toSavings === toWallet) {
      return res.status(400).json({
        success: false,
        message: toSavings
          ? 'Destination invalide'
          : 'Choisissez une poche de destination ou un objectif d\'épargne',
      });
    }

    if (toSavings) {
      const transaction = await allocateToSavingsGoal({
        userId: req.user!._id,
        type: 'expense',
        amount: value.amount,
        wallet_id: value.wallet_id,
        savings_goal_id: value.savings_goal_id,
        description: value.description,
        date: value.date,
      });
      const populated = await Transaction.findById(transaction._id)
        .populate('wallet_id')
        .populate('savings_goal_id');
      return res.status(201).json({
        success: true,
        data: { debit: populated, credit: null },
      });
    }

    const sourceWallet = await Wallet.findOne({
      _id: value.wallet_id,
      user_id: req.user!._id,
      is_deleted: { $ne: true },
    });
    const destWallet = await Wallet.findOne({
      _id: value.destination_wallet_id,
      user_id: req.user!._id,
      is_deleted: { $ne: true },
    });

    if (!sourceWallet || !destWallet) {
      return res.status(404).json({
        success: false,
        message: 'Portefeuille introuvable',
      });
    }

    if (String(sourceWallet._id) === String(destWallet._id)) {
      return res.status(400).json({
        success: false,
        message: 'Impossible de transférer vers le même portefeuille',
      });
    }

    const source_balance_before = sourceWallet.current_balance;
    const source_balance_after = source_balance_before - value.amount;

    if (source_balance_after < 0) {
      return res.status(400).json({
        success: false,
        message: 'Solde insuffisant pour ce transfert',
      });
    }

    const dest_balance_before = destWallet.current_balance;
    const dest_balance_after = dest_balance_before + value.amount;
    const transferGroupId = new mongoose.Types.ObjectId();

    const debit = await Transaction.create({
      user_id: req.user!._id,
      type: 'transfer',
      amount: value.amount,
      wallet_id: sourceWallet._id,
      destination_wallet_id: destWallet._id,
      transfer_group_id: transferGroupId,
      is_transfer_mirror: false,
      description: value.description || `Transfert vers ${destWallet.name}`,
      date: value.date || new Date(),
      balance_before: source_balance_before,
      balance_after: source_balance_after,
    });

    const credit = await Transaction.create({
      user_id: req.user!._id,
      type: 'transfer',
      amount: value.amount,
      wallet_id: destWallet._id,
      destination_wallet_id: sourceWallet._id,
      transfer_group_id: transferGroupId,
      is_transfer_mirror: true,
      description: value.description || `Transfert de ${sourceWallet.name}`,
      date: value.date || new Date(),
      balance_before: dest_balance_before,
      balance_after: dest_balance_after,
    });

    sourceWallet.current_balance = source_balance_after;
    destWallet.current_balance = dest_balance_after;
    await sourceWallet.save();
    await destWallet.save();

    const populatedDebit = await Transaction.findById(debit._id)
      .populate('wallet_id')
      .populate('destination_wallet_id');
    const populatedCredit = await Transaction.findById(credit._id)
      .populate('wallet_id')
      .populate('destination_wallet_id');

    return res.status(201).json({
      success: true,
      data: { debit: populatedDebit, credit: populatedCredit },
    });
  } catch (error) {
    console.error('Erreur transfer:', error);
    const message =
      error instanceof Error ? error.message : 'Erreur lors du transfert';
    return res.status(400).json({ success: false, message });
  }
});

const transactionUpdateSchema = Joi.object({
  description: Joi.string().allow('', null).optional(),
  amount: Joi.number().positive().optional(),
  wallet_id: Joi.string().optional(),
  category_id: Joi.string().allow(null, '').optional(),
  date: Joi.date().iso().optional(),
});

router.put('/:id', protect, async (req: Request, res: Response) => {
  try {
    const { error, value } = transactionUpdateSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const transaction = await Transaction.findOne({
      _id: req.params.id,
      user_id: req.user!._id,
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction introuvable',
      });
    }

    if (transaction.type === 'transfer') {
      return res.status(400).json({
        success: false,
        message: "La modification des transferts n'est pas supportée",
      });
    }

    const oldAmount = transaction.amount;
    const newAmount = value.amount ?? oldAmount;
    const oldWalletId = String(transaction.wallet_id);
    const newWalletId = value.wallet_id ?? oldWalletId;

    if (value.description !== undefined) {
      transaction.description = value.description || '';
    }
    if (value.date) {
      transaction.date = new Date(value.date);
    }
    if (value.category_id !== undefined) {
      transaction.category_id = value.category_id
        ? new mongoose.Types.ObjectId(value.category_id)
        : null;
    }

    const walletChanged = newWalletId !== oldWalletId;

    if (walletChanged) {
      const oldWallet = await Wallet.findOne({
        _id: oldWalletId,
        user_id: req.user!._id,
        is_deleted: { $ne: true },
      });
      const newWallet = await Wallet.findOne({
        _id: newWalletId,
        user_id: req.user!._id,
        is_deleted: { $ne: true },
      });

      if (!oldWallet || !newWallet) {
        return res.status(404).json({
          success: false,
          message: 'Portefeuille introuvable',
        });
      }

      if (transaction.type === 'income') {
        oldWallet.current_balance -= oldAmount;
      } else {
        oldWallet.current_balance += oldAmount;
      }
      await oldWallet.save();

      const balance_before = newWallet.current_balance;
      let balance_after: number;

      if (transaction.type === 'income') {
        balance_after = balance_before + newAmount;
        newWallet.current_balance = balance_after;
      } else {
        balance_after = balance_before - newAmount;
        if (balance_after < 0) {
          return res.status(400).json({
            success: false,
            message: 'Solde insuffisant sur la poche sélectionnée',
          });
        }
        newWallet.current_balance = balance_after;
      }

      await newWallet.save();

      transaction.wallet_id = new mongoose.Types.ObjectId(newWalletId);
      transaction.balance_before = balance_before;
      transaction.balance_after = balance_after;
      transaction.amount = newAmount;
    } else {
      const wallet = await Wallet.findOne({
        _id: transaction.wallet_id,
        user_id: req.user!._id,
        is_deleted: { $ne: true },
      });

      if (!wallet) {
        return res.status(404).json({
          success: false,
          message: 'Portefeuille introuvable',
        });
      }

      const delta = newAmount - oldAmount;

      if (transaction.type === 'income') {
        wallet.current_balance += delta;
        transaction.balance_after = transaction.balance_before + newAmount;
      } else {
        wallet.current_balance -= delta;
        if (wallet.current_balance < 0) {
          return res.status(400).json({
            success: false,
            message: 'Solde insuffisant pour ce montant',
          });
        }
        transaction.balance_after = transaction.balance_before - newAmount;
      }

      transaction.amount = newAmount;
      await wallet.save();
    }

    await transaction.save();

    const populated = await Transaction.findById(transaction._id)
      .populate('wallet_id')
      .populate('destination_wallet_id')
      .populate('category_id');

    return res.json({ success: true, data: populated });
  } catch (error) {
    console.error('Erreur update transaction:', error);
    const message =
      error instanceof Error ? error.message : 'Erreur lors de la mise à jour';
    return res.status(400).json({ success: false, message });
  }
});

router.delete('/:id', protect, async (req: Request, res: Response) => {
  try {
    const transaction = await Transaction.findOne({
      _id: req.params.id,
      user_id: req.user!._id,
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction introuvable',
      });
    }

    if (transaction.type === 'transfer') {
      await deleteTransferGroup(transaction, req.user!._id);
    } else {
      await reverseSimpleTransaction(transaction, req.user!._id);
      await Transaction.findByIdAndDelete(transaction._id);
    }

    return res.json({
      success: true,
      message: 'Transaction supprimée',
    });
  } catch (error) {
    console.error('Erreur delete transaction:', error);
    const message =
      error instanceof Error
        ? error.message
        : 'Erreur lors de la suppression';
    return res.status(400).json({ success: false, message });
  }
});

export default router;
