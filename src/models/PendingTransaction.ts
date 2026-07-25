import mongoose, { Schema, Document, Model, Types } from 'mongoose';

/** `pending` = pending_validation (jamais validé auto). */
export type PendingTransactionStatus = 'pending' | 'validated' | 'rejected';
export type PendingTransactionSource = 'sms' | 'notification' | 'ai_scan' | 'manual';
/** Origine fine : image IA, notification parsée, ou extraction IA niveau 3. */
export type PendingSourceType = 'image' | 'parser' | 'ai' | 'sms' | 'manual';
export type MobileOperator = 'orange' | 'mtn' | 'unknown';
export type SmsPatternKind =
  | 'transfer_out'
  | 'transfer_in'
  | 'payment'
  | 'withdrawal'
  | 'unknown';

export interface IPendingTransaction extends Document {
  user_id: Types.ObjectId;
  status: PendingTransactionStatus;
  source: PendingTransactionSource;
  source_type?: PendingSourceType;
  document_type?: string;
  type: 'income' | 'expense';
  amount: number;
  operator: MobileOperator;
  counterparty: string;
  description: string;
  date: Date;
  raw_text: string;
  wallet_id: Types.ObjectId | null;
  category_id: Types.ObjectId | null;
  confidence: number;
  pattern: SmsPatternKind;
  transaction_id: string;
  ai_enriched: boolean;
  low_confidence_warning?: string;
  ai_items: Array<{
    description: string;
    amount: number;
    type: 'income' | 'expense';
  }>;
  validated_transaction_id: Types.ObjectId | null;
  created_at: Date;
}

const pendingTransactionSchema = new Schema<IPendingTransaction>(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'validated', 'rejected'],
      default: 'pending',
      index: true,
    },
    source: {
      type: String,
      enum: ['sms', 'notification', 'ai_scan', 'manual'],
      required: true,
    },
    source_type: {
      type: String,
      enum: ['image', 'parser', 'ai', 'sms', 'manual'],
      default: undefined,
    },
    document_type: { type: String, default: undefined },
    type: {
      type: String,
      enum: ['income', 'expense'],
      default: 'expense',
    },
    low_confidence_warning: { type: String, default: undefined },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    operator: {
      type: String,
      enum: ['orange', 'mtn', 'unknown'],
      default: 'unknown',
    },
    counterparty: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    date: { type: Date, default: Date.now },
    raw_text: { type: String, default: '' },
    wallet_id: { type: Schema.Types.ObjectId, ref: 'Wallet', default: null },
    category_id: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    confidence: { type: Number, min: 0, max: 1, default: 0.5 },
    pattern: {
      type: String,
      enum: ['transfer_out', 'transfer_in', 'payment', 'withdrawal', 'unknown'],
      default: 'unknown',
    },
    transaction_id: { type: String, default: '', index: true },
    ai_enriched: { type: Boolean, default: false },
    ai_items: {
      type: [
        {
          description: String,
          amount: Number,
          type: { type: String, enum: ['income', 'expense'] },
        },
      ],
      default: [],
    },
    validated_transaction_id: {
      type: Schema.Types.ObjectId,
      ref: 'Transaction',
      default: null,
    },
    created_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

pendingTransactionSchema.index({ user_id: 1, status: 1, created_at: -1 });

const PendingTransaction: Model<IPendingTransaction> =
  mongoose.models.PendingTransaction ||
  mongoose.model<IPendingTransaction>('PendingTransaction', pendingTransactionSchema);

export default PendingTransaction;
