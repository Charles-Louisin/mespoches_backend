import mongoose, { Schema, Document, Model } from 'mongoose'

/**
 * Motifs de notifications appris (souvent après une extraction IA niveau 3).
 * Réutilisés par NotificationParserService pour réduire les appels IA.
 */
export interface INotificationPattern extends Document {
  fingerprint: string
  regex: string
  sample_text: string
  default_type: 'income' | 'expense'
  default_description: string
  default_counterparty: string
  operator: string
  pattern: string
  amount_group: number
  counterparty_group: number
  source: 'ai' | 'manual'
  active: boolean
  hit_count: number
  learn_count: number
  last_hit_at?: Date
  last_learned_at?: Date
  created_at: Date
}

const notificationPatternSchema = new Schema<INotificationPattern>(
  {
    fingerprint: { type: String, required: true, unique: true, index: true },
    regex: { type: String, required: true },
    sample_text: { type: String, default: '' },
    default_type: { type: String, enum: ['income', 'expense'], default: 'expense' },
    default_description: { type: String, default: '' },
    default_counterparty: { type: String, default: '' },
    operator: { type: String, default: 'unknown' },
    pattern: { type: String, default: 'unknown' },
    amount_group: { type: Number, default: 1 },
    counterparty_group: { type: Number, default: 0 },
    source: { type: String, enum: ['ai', 'manual'], default: 'ai' },
    active: { type: Boolean, default: true },
    hit_count: { type: Number, default: 0 },
    learn_count: { type: Number, default: 1 },
    last_hit_at: { type: Date },
    last_learned_at: { type: Date },
    created_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
)

const NotificationPattern: Model<INotificationPattern> =
  mongoose.models.NotificationPattern ||
  mongoose.model<INotificationPattern>('NotificationPattern', notificationPatternSchema)

export default NotificationPattern
