import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export interface ICategory extends Document {
  user_id: Types.ObjectId;
  name: string;
  type: 'income' | 'expense';
  image_url: string | null;
  created_at: Date;
}

const categorySchema = new Schema<ICategory>(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, "L'utilisateur est requis"],
    },
    name: {
      type: String,
      required: [true, 'Le nom de la catégorie est requis'],
      trim: true,
    },
    type: {
      type: String,
      enum: ['income', 'expense'],
      required: [true, 'Le type est requis'],
    },
    image_url: {
      type: String,
      default: null,
      trim: true,
    },
    created_at: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

categorySchema.index({ user_id: 1, type: 1 });

const Category: Model<ICategory> =
  mongoose.models.Category || mongoose.model<ICategory>('Category', categorySchema);

export default Category;
