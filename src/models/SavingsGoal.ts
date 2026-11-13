import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export interface IGoalTip {
  /** 'start' : conseil de début de mois ; 'end' : bilan de fin de mois. */
  period: 'start' | 'end';
  /** Mois concerné, AAAA-MM. */
  month: string;
  text: string;
  created_at: Date;
}

export interface ISavingsGoal extends Document {
  user_id: Types.ObjectId;
  title: string;
  target_amount: number;
  saved_amount: number;
  deadline: Date | null;
  /** Date à laquelle l'objectif a été atteint (épargne ≥ cible) ou marqué comme réalisé. */
  achieved_at: Date | null;
  /** Dernière alerte « réalisable avec vos poches » envoyée (remise à null si ce n'est plus le cas). */
  achievable_notified_at: Date | null;
  ai_tips: IGoalTip[];
  created_at: Date;
}

const goalTipSchema = new Schema<IGoalTip>(
  {
    period: { type: String, enum: ['start', 'end'], required: true },
    month: { type: String, required: true },
    text: { type: String, required: true, trim: true },
    created_at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const savingsGoalSchema = new Schema<ISavingsGoal>(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    title: { type: String, required: true, trim: true },
    target_amount: { type: Number, required: true, min: 0.01 },
    saved_amount: { type: Number, default: 0, min: 0 },
    deadline: { type: Date, default: null },
    achieved_at: { type: Date, default: null },
    achievable_notified_at: { type: Date, default: null },
    ai_tips: { type: [goalTipSchema], default: [] },
    created_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

savingsGoalSchema.index({ user_id: 1, achieved_at: 1, created_at: -1 });

const SavingsGoal: Model<ISavingsGoal> =
  mongoose.models.SavingsGoal ||
  mongoose.model<ISavingsGoal>('SavingsGoal', savingsGoalSchema);

export default SavingsGoal;
