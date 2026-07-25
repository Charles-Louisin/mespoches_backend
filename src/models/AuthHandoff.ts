import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IAuthHandoff extends Document {
  codeHash: string;
  /** Hash SHA-256 du nonce généré dans la WebView (anti-hijack custom scheme). */
  clientNonceHash: string;
  token: string;
  emailVerified: boolean;
  expiresAt: Date;
  createdAt: Date;
}

const authHandoffSchema = new Schema<IAuthHandoff>(
  {
    codeHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    clientNonceHash: {
      type: String,
      required: true,
      index: true,
    },
    token: {
      type: String,
      required: true,
    },
    emailVerified: {
      type: Boolean,
      default: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 },
    },
  },
  { timestamps: true }
);

const AuthHandoff: Model<IAuthHandoff> =
  mongoose.models.AuthHandoff ||
  mongoose.model<IAuthHandoff>('AuthHandoff', authHandoffSchema);

export default AuthHandoff;
