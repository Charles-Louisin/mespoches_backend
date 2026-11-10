import mongoose, { Schema, Document, Model, Types } from 'mongoose';

/**
 * Version d'APK publiée manuellement par un administrateur (quand la release GitHub n'a pas d'APK,
 * ou pour forcer / annoncer une mise à jour). Une seule active à la fois.
 */
export interface IAppRelease extends Document {
  version: string;
  apkUrl: string;
  notes: string | null;
  minVersion: string | null;
  active: boolean;
  publishedBy: Types.ObjectId | null;
  created_at: Date;
}

const appReleaseSchema = new Schema<IAppRelease>(
  {
    version: { type: String, required: true },
    apkUrl: { type: String, required: true },
    notes: { type: String, default: null },
    minVersion: { type: String, default: null },
    active: { type: Boolean, default: true, index: true },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    created_at: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

const AppRelease: Model<IAppRelease> =
  mongoose.models.AppRelease || mongoose.model<IAppRelease>('AppRelease', appReleaseSchema);

export default AppRelease;
