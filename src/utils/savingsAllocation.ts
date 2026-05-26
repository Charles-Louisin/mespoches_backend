import { Types } from 'mongoose';
import SavingsGoal from '../models/SavingsGoal';
import Wallet from '../models/Wallet';
import Transaction, { ITransaction } from '../models/Transaction';

interface AllocateInput {
  userId: Types.ObjectId;
  amount: number;
  wallet_id?: string | null;
  savings_goal_id: string;
  type: 'income' | 'expense';
  category_id?: string | null;
  description?: string | null;
  date?: Date;
}

export async function allocateToSavingsGoal(
  input: AllocateInput
): Promise<ITransaction> {
  const goal = await SavingsGoal.findOne({
    _id: input.savings_goal_id,
    user_id: input.userId,
  });
  if (!goal) {
    throw new Error('Objectif d\'épargne introuvable');
  }

  let balance_before = 0;
  let balance_after = 0;
  let walletId: Types.ObjectId | null = null;

  if (input.type === 'expense') {
    if (!input.wallet_id) {
      throw new Error('Poche requise pour alimenter l\'épargne');
    }
    const wallet = await Wallet.findOne({
      _id: input.wallet_id,
      user_id: input.userId,
      is_deleted: { $ne: true },
    });
    if (!wallet) {
      throw new Error('Portefeuille introuvable');
    }
    walletId = wallet._id;
    balance_before = wallet.current_balance;
    balance_after = balance_before - input.amount;
    if (balance_after < 0) {
      throw new Error('Solde insuffisant pour cette épargne');
    }
    wallet.current_balance = balance_after;
    await wallet.save();
  } else if (input.wallet_id) {
    const wallet = await Wallet.findOne({
      _id: input.wallet_id,
      user_id: input.userId,
      is_deleted: { $ne: true },
    });
    if (wallet) {
      walletId = wallet._id;
      balance_before = wallet.current_balance;
      balance_after = balance_before;
    }
  }

  goal.saved_amount = (goal.saved_amount ?? 0) + input.amount;
  await goal.save();

  const desc =
    input.description?.trim() ||
    `Épargne → ${goal.title}`;

  const transaction = await Transaction.create({
    user_id: input.userId,
    type: input.type,
    amount: input.amount,
    wallet_id: walletId,
    savings_goal_id: input.savings_goal_id,
    category_id: input.category_id || null,
    description: desc,
    date: input.date || new Date(),
    balance_before,
    balance_after,
  });

  return transaction;
}

export async function getTotalSavings(userId: Types.ObjectId): Promise<number> {
  const result = await SavingsGoal.aggregate([
    { $match: { user_id: userId } },
    { $group: { _id: null, total: { $sum: '$saved_amount' } } },
  ]);
  return result[0]?.total ?? 0;
}
