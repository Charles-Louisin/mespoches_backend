import mongoose, { Schema, Document, Model, Types } from 'mongoose';
import type { PaidTier } from '../config/planLimits';

export type BillingPeriod = 'monthly' | 'yearly';
export type SubscriptionPaymentStatus = 'pending' | 'completed' | 'failed';

export interface ISubscriptionPayment extends Document {
  user_id: Types.ObjectId;
  transaction_id: string;
  period: BillingPeriod;
  tier: PaidTier;
  amount: number;
  currency: string;
  status: SubscriptionPaymentStatus;
  provider: 'saspay';
  saspay_session_id?: string | null;
  saspay_transaction_id?: string | null;
  saspay_status?: string | null;
  saspay_charged?: string | null;
  saspay_net_amount?: string | null;
  saspay_currency?: string | null;
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
    tier: {
      type: String,
      enum: ['pro', 'pro_plus', 'business'],
      default: 'pro',
    },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'XAF' },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed'],
      default: 'pending',
      index: true,
    },
    provider: { type: String, enum: ['saspay'], default: 'saspay' },
    saspay_session_id: { type: String, default: null, index: true },
    saspay_transaction_id: { type: String, default: null, index: true },
    saspay_status: { type: String, default: null },
    saspay_charged: { type: String, default: null },
    saspay_net_amount: { type: String, default: null },
    saspay_currency: { type: String, default: null },
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
