import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export type BillingPeriod = 'monthly' | 'yearly';
export type SubscriptionPaymentStatus = 'pending' | 'completed' | 'failed';

export interface ISubscriptionPayment extends Document {
  user_id: Types.ObjectId;
  transaction_id: string;
  period: BillingPeriod;
  amount: number;
  currency: string;
  status: SubscriptionPaymentStatus;
  cinetpay_payment_token?: string | null;
  completed_at?: Date | null;
  created_at: Date;
}

const subscriptionPaymentSchema = new Schema<ISubscriptionPayment>(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    transaction_id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    period: {
      type: String,
      enum: ['monthly', 'yearly'],
      required: true,
    },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'XAF' },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed'],
      default: 'pending',
    },
    cinetpay_payment_token: { type: String, default: null },
    completed_at: { type: Date, default: null },
    created_at: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

const SubscriptionPayment: Model<ISubscriptionPayment> =
  mongoose.models.SubscriptionPayment ||
  mongoose.model<ISubscriptionPayment>(
    'SubscriptionPayment',
    subscriptionPaymentSchema
  );

export default SubscriptionPayment;
