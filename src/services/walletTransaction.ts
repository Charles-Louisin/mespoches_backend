import { Types } from 'mongoose';
import Transaction, { ITransaction } from '../models/Transaction';
import Wallet from '../models/Wallet';

export interface ExpenseInput {
  amount: number;
  wallet_id: string;
  category_id?: string | null;
  description?: string | null;
  date?: Date;
}

export async function debitWallet(
  userId: Types.ObjectId,
  walletId: string | Types.ObjectId,
  amount: number
) {
  const updated = await Wallet.findOneAndUpdate(
    {
      _id: walletId,
      user_id: userId,
      is_deleted: { $ne: true },
      current_balance: { $gte: amount },
    },
    { $inc: { current_balance: -amount } },
    { new: true }
  );
  if (!updated) {
    throw new Error('Solde insuffisant ou portefeuille introuvable');
  }
  return updated;
}

export async function creditWallet(
  userId: Types.ObjectId,
  walletId: string | Types.ObjectId,
  amount: number
) {
  const updated = await Wallet.findOneAndUpdate(
    {
      _id: walletId,
      user_id: userId,
      is_deleted: { $ne: true },
    },
    { $inc: { current_balance: amount } },
    { new: true }
  );
  if (!updated) {
    throw new Error('Portefeuille introuvable');
  }
  return updated;
}

/** Crée une dépense immédiate et met à jour le solde de la poche. */
export async function createExpenseTransaction({
  userId,
  data,
}: {
  userId: Types.ObjectId;
  data: ExpenseInput;
}): Promise<ITransaction> {
  const wallet = await debitWallet(userId, data.wallet_id, data.amount);
  const balance_after = wallet.current_balance;
  const balance_before = balance_after + data.amount;

  try {
    return await Transaction.create({
      user_id: userId,
      type: 'expense',
      amount: data.amount,
      wallet_id: data.wallet_id,
      category_id: data.category_id || null,
      description: data.description || '',
      date: data.date || new Date(),
      balance_before,
      balance_after,
    });
  } catch (err) {
    await creditWallet(userId, data.wallet_id, data.amount);
    throw err;
  }
}
