import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export interface IBudget extends Document {
  user_id: Types.ObjectId;
  category_id: Types.ObjectId;
  year: number;
  month: number;
  limit_amount: number;
  created_at: Date;
}

const budgetSchema = new Schema<IBudget>(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    category_id: {
      type: Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
    },
    year: { type: Number, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    limit_amount: { type: Number, required: true, min: 0 },
    created_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

budgetSchema.index(
  { user_id: 1, category_id: 1, year: 1, month: 1 },
  { unique: true }
);

const Budget: Model<IBudget> =
  mongoose.models.Budget || mongoose.model<IBudget>('Budget', budgetSchema);

export default Budget;
