import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export type PlannedExpenseStatus = 'scheduled' | 'executed' | 'cancelled';
export type PlannedExpenseCancelledReason = 'user' | 'insufficient_balance';

export interface IPlannedExpense extends Document {
  user_id: Types.ObjectId;
  wallet_id: Types.ObjectId;
  category_id: Types.ObjectId | null;
  amount: number;
  description: string;
  /** Jour d'exécution prévu (00:00:00 UTC). */
  scheduled_date: Date;
  status: PlannedExpenseStatus;
  cancelled_reason: PlannedExpenseCancelledReason | null;
  executed_transaction_id: Types.ObjectId | null;
  reminder_sent_at: Date | null;
  created_at: Date;
}

const plannedExpenseSchema = new Schema<IPlannedExpense>(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    wallet_id: {
      type: Schema.Types.ObjectId,
      ref: 'Wallet',
      required: true,
      index: true,
    },
    category_id: {
      type: Schema.Types.ObjectId,
      ref: 'Category',
      default: null,
    },
    amount: {
      type: Number,
      required: true,
      min: [0.01, 'Le montant doit être supérieur à 0'],
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    scheduled_date: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['scheduled', 'executed', 'cancelled'],
      default: 'scheduled',
      index: true,
    },
    cancelled_reason: {
      type: String,
      enum: ['user', 'insufficient_balance', null],
      default: null,
    },
    executed_transaction_id: {
      type: Schema.Types.ObjectId,
      ref: 'Transaction',
      default: null,
    },
    reminder_sent_at: {
      type: Date,
      default: null,
    },
    created_at: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

plannedExpenseSchema.index({ user_id: 1, status: 1, scheduled_date: 1 });
plannedExpenseSchema.index({
  status: 1,
  scheduled_date: 1,
  reminder_sent_at: 1,
});

const PlannedExpense: Model<IPlannedExpense> =
  mongoose.models.PlannedExpense ||
  mongoose.model<IPlannedExpense>('PlannedExpense', plannedExpenseSchema);

export default PlannedExpense;
