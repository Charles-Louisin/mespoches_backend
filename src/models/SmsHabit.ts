import mongoose, { Schema, Document, Model, Types } from 'mongoose';
import type { SmsPatternKind } from '../utils/mobileMoneySmsParser';

export interface ISmsHabit extends Document {
  user_id: Types.ObjectId;
  counterparty_key: string;
  counterparty: string;
  pattern: SmsPatternKind;
  type: 'income' | 'expense';
  wallet_id: Types.ObjectId | null;
  category_id: Types.ObjectId | null;
  description: string;
  validation_count: number;
  last_validated_at: Date;
  /** Noms / numéros appris comme identité Mobile Money de l'utilisateur */
  learned_names: string[];
  learned_phones: string[];
  created_at: Date;
}

const smsHabitSchema = new Schema<ISmsHabit>(
  {
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    counterparty_key: { type: String, required: true, index: true },
    counterparty: { type: String, default: '' },
    pattern: {
      type: String,
      enum: ['transfer_out', 'transfer_in', 'payment', 'withdrawal', 'unknown'],
      default: 'unknown',
    },
    type: { type: String, enum: ['income', 'expense'], required: true },
    wallet_id: { type: Schema.Types.ObjectId, ref: 'Wallet', default: null },
    category_id: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    description: { type: String, default: '' },
    validation_count: { type: Number, default: 1 },
    last_validated_at: { type: Date, default: Date.now },
    learned_names: { type: [String], default: [] },
    learned_phones: { type: [String], default: [] },
    created_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

smsHabitSchema.index({ user_id: 1, counterparty_key: 1 }, { unique: true });

const SmsHabit: Model<ISmsHabit> =
  mongoose.models.SmsHabit || mongoose.model<ISmsHabit>('SmsHabit', smsHabitSchema);

export default SmsHabit;
