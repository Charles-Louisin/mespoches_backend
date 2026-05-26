import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export type TransactionType = 'income' | 'expense' | 'transfer';

export interface ITransaction extends Document {
  user_id: Types.ObjectId;
  type: TransactionType;
  amount: number;
  wallet_id: Types.ObjectId | null;
  destination_wallet_id: Types.ObjectId | null;
  transfer_group_id: Types.ObjectId | null;
  is_transfer_mirror: boolean;
  category_id: Types.ObjectId | null;
  savings_goal_id: Types.ObjectId | null;
  description: string;
  date: Date;
  balance_before: number;
  balance_after: number;
  created_at: Date;
}

const transactionSchema = new Schema<ITransaction>(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, "L'utilisateur est requis"],
    },
    type: {
      type: String,
      enum: ['income', 'expense', 'transfer'],
      required: [true, 'Le type de transaction est requis'],
    },
    amount: {
      type: Number,
      required: [true, 'Le montant est requis'],
      min: [0.01, 'Le montant doit être supérieur à 0'],
    },
    wallet_id: {
      type: Schema.Types.ObjectId,
      ref: 'Wallet',
      default: null,
    },
    destination_wallet_id: {
      type: Schema.Types.ObjectId,
      ref: 'Wallet',
      default: null,
    },
    transfer_group_id: {
      type: Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    is_transfer_mirror: {
      type: Boolean,
      default: false,
      index: true,
    },
    category_id: {
      type: Schema.Types.ObjectId,
      ref: 'Category',
      default: null,
    },
    savings_goal_id: {
      type: Schema.Types.ObjectId,
      ref: 'SavingsGoal',
      default: null,
      index: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    date: {
      type: Date,
      default: Date.now,
    },
    balance_before: {
      type: Number,
      required: true,
    },
    balance_after: {
      type: Number,
      required: true,
    },
    created_at: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

transactionSchema.index({ user_id: 1, wallet_id: 1, date: -1 });
transactionSchema.index({ user_id: 1, date: -1 });

const Transaction: Model<ITransaction> =
  mongoose.models.Transaction ||
  mongoose.model<ITransaction>('Transaction', transactionSchema);

export default Transaction;
