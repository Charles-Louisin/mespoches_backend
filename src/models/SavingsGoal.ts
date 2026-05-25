import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export interface ISavingsGoal extends Document {
  user_id: Types.ObjectId;
  title: string;
  target_amount: number;
  wallet_id: Types.ObjectId | null;
  deadline: Date | null;
  created_at: Date;
}

const savingsGoalSchema = new Schema<ISavingsGoal>(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    title: { type: String, required: true, trim: true },
    target_amount: { type: Number, required: true, min: 0.01 },
    wallet_id: {
      type: Schema.Types.ObjectId,
      ref: 'Wallet',
      default: null,
    },
    deadline: { type: Date, default: null },
    created_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const SavingsGoal: Model<ISavingsGoal> =
  mongoose.models.SavingsGoal ||
  mongoose.model<ISavingsGoal>('SavingsGoal', savingsGoalSchema);

export default SavingsGoal;
