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

/** Crée une dépense immédiate et met à jour le solde de la poche. */
export async function createExpenseTransaction({
  userId,
  data,
}: {
  userId: Types.ObjectId;
  data: ExpenseInput;
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
  const balance_after = balance_before - data.amount;

  if (balance_after < 0) {
    throw new Error('Solde insuffisant pour cette dépense');
  }

  const transaction = await Transaction.create({
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

  wallet.current_balance = balance_after;
  await wallet.save();

  return transaction;
}
