import mongoose, { Schema, Document, Model, Types } from 'mongoose';

/**
 * Enregistrement en lot (plusieurs poches, plusieurs transactions) traité en arrière-plan.
 * La progression est mesurée en lignes enregistrées : c'est ce que l'app affiche, au pourcentage près.
 */
export interface IBatchJob extends Document {
  user_id: Types.ObjectId;
  status: 'running' | 'done';
  /** Nombre de transactions du lot. */
  total: number;
  done: number;
  failed: number;
  /** Unités de travail (lignes) : base du pourcentage. */
  total_units: number;
  done_units: number;
  failures: { index: number; message: string }[];
  created_at: Date;
  finished_at: Date | null;
}

const batchJobSchema = new Schema<IBatchJob>(
  {
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: ['running', 'done'], default: 'running' },
    total: { type: Number, required: true },
    done: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    total_units: { type: Number, required: true },
    done_units: { type: Number, default: 0 },
    failures: { type: [new Schema({ index: Number, message: String }, { _id: false })], default: [] },
    created_at: { type: Date, default: Date.now },
    finished_at: { type: Date, default: null },
  },
  { timestamps: false }
);

// Purge automatique après 3 jours.
batchJobSchema.index({ created_at: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60 });

const BatchJob: Model<IBatchJob> =
  mongoose.models.BatchJob || mongoose.model<IBatchJob>('BatchJob', batchJobSchema);

export default BatchJob;
