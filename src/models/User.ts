import mongoose, { Schema, Document, Model } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface ILoginHistoryEntry {
  date: Date;
  ip: string | null;
  userAgent: string | null;
}

export type UserPlan = 'free' | 'premium';
export type AuthProvider = 'email' | 'google';

export interface IUser extends Document {
  email: string;
  password?: string;
  googleId?: string | null;
  authProvider: AuthProvider;
  emailVerified: boolean;
  verificationCode?: string | null;
  verificationCodeExpires?: Date | null;
  lastVerificationSentAt?: Date | null;
  verificationAttempts?: number;
  role: 'user' | 'admin';
  plan: UserPlan;
  premiumUntil: Date | null;
  name?: string;
  currency: string;
  hidePlannedExpensesHelp: boolean;
  lastLoginAt: Date | null;
  loginHistory: ILoginHistoryEntry[];
  created_at: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: [true, "L'email est requis"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Email invalide'],
    },
    password: {
      type: String,
      required: [
        function (this: IUser) {
          return this.authProvider !== 'google' && !this.googleId;
        },
        'Le mot de passe est requis',
      ],
      minlength: [10, 'Le mot de passe doit contenir au moins 10 caractères'],
      select: false,
    },
    googleId: {
      type: String,
      default: null,
      sparse: true,
      unique: true,
    },
    authProvider: {
      type: String,
      enum: ['email', 'google'],
      default: 'email',
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    verificationCode: {
      type: String,
      select: false,
      default: null,
    },
    verificationCodeExpires: {
      type: Date,
      default: null,
    },
    lastVerificationSentAt: {
      type: Date,
      default: null,
    },
    verificationAttempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },
    plan: {
      type: String,
      enum: ['free', 'premium'],
      default: 'free',
    },
    premiumUntil: {
      type: Date,
      default: null,
    },
    name: {
      type: String,
      trim: true,
    },
    currency: {
      type: String,
      enum: ['XAF', 'XOF', 'EURO', 'DOLLARS'],
      default: 'XAF',
    },
    hidePlannedExpensesHelp: {
      type: Boolean,
      default: false,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    loginHistory: [
      {
        date: { type: Date, default: Date.now },
        ip: { type: String, default: null },
        userAgent: { type: String, default: null },
      },
    ],
    created_at: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error as Error);
  }
});

userSchema.methods.comparePassword = async function (
  candidatePassword: string
): Promise<boolean> {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

const User: Model<IUser> =
  mongoose.models.User || mongoose.model<IUser>('User', userSchema);

export default User;
