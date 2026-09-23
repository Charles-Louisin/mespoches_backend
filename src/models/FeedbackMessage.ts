import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export type FeedbackFrom = 'user' | 'admin';

export interface IFeedbackMessage extends Document {
  user_id: Types.ObjectId;
  author_id: Types.ObjectId;
  from: FeedbackFrom;
  body: string;
  created_at: Date;
  read_at: Date | null;
}

const feedbackMessageSchema = new Schema<IFeedbackMessage>({
  user_id: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  author_id: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  from: {
    type: String,
    enum: ['user', 'admin'],
    required: true,
  },
  body: {
    type: String,
    required: true,
    maxlength: 4000,
  },
  created_at: {
    type: Date,
    default: Date.now,
    index: true,
  },
  read_at: {
    type: Date,
    default: null,
  },
});

feedbackMessageSchema.index({ user_id: 1, created_at: 1 });
feedbackMessageSchema.index({ from: 1, read_at: 1 });

const FeedbackMessage: Model<IFeedbackMessage> =
  mongoose.models.FeedbackMessage ||
  mongoose.model<IFeedbackMessage>('FeedbackMessage', feedbackMessageSchema);

export default FeedbackMessage;
