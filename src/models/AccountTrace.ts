import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Trace anonymisée d'une identité ayant déjà eu un compte (anti-abus de l'essai gratuit).
 * Aucune donnée lisible : `hash` est un HMAC-SHA256 (secret serveur) de l'email normalisé,
 * de l'identifiant Google ou de la clé d'installation de l'app. Survit à la suppression du compte.
 */
export type TraceKind = 'email' | 'google' | 'device';

export interface IAccountTrace extends Document {
  kind: TraceKind;
  hash: string;
  trialGrantedAt: Date | null;
  accountsCreated: number;
  deletedCount: number;
  lastDeletedAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

const accountTraceSchema = new Schema<IAccountTrace>(
  {
    kind: { type: String, enum: ['email', 'google', 'device'], required: true },
    hash: { type: String, required: true },
    trialGrantedAt: { type: Date, default: null },
    accountsCreated: { type: Number, default: 0 },
    deletedCount: { type: Number, default: 0 },
    lastDeletedAt: { type: Date, default: null },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

accountTraceSchema.index({ kind: 1, hash: 1 }, { unique: true });

const AccountTrace: Model<IAccountTrace> =
  mongoose.models.AccountTrace || mongoose.model<IAccountTrace>('AccountTrace', accountTraceSchema);

export default AccountTrace;
