import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export type RecurringFrequency = 'weekly' | 'monthly';

export interface IRecurringTransaction extends Document {
  user_id: Types.ObjectId;
  type: 'income' | 'expense';
  amount: number;
  wallet_id: Types.ObjectId;
  category_id: Types.ObjectId | null;
  description: string;
  frequency: RecurringFrequency;
  day_of_month: number | null;
  next_run_date: Date;
  active: boolean;
  created_at: Date;
}

const recurringSchema = new Schema<IRecurringTransaction>(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      enum: ['income', 'expense'],
      required: true,
    },
    amount: { type: Number, required: true, min: 0.01 },
    wallet_id: {
      type: Schema.Types.ObjectId,
      ref: 'Wallet',
      required: true,
    },
    category_id: {
      type: Schema.Types.ObjectId,
      ref: 'Category',
      default: null,
    },
    description: { type: String, default: '' },
    frequency: {
      type: String,
      enum: ['weekly', 'monthly'],
      default: 'monthly',
    },
    day_of_month: { type: Number, min: 1, max: 31, default: null },
    next_run_date: { type: Date, required: true },
    active: { type: Boolean, default: true },
    created_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const RecurringTransaction: Model<IRecurringTransaction> =
  mongoose.models.RecurringTransaction ||
  mongoose.model<IRecurringTransaction>(
    'RecurringTransaction',
    recurringSchema
  );

export default RecurringTransaction;
