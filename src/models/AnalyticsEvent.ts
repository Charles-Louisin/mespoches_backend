import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export interface IAnalyticsEvent extends Document {
  user_id: Types.ObjectId;
  name: string;
  screen: string;
  platform: string;
  props: Record<string, string | number>;
  created_at: Date;
}

const analyticsEventSchema = new Schema<IAnalyticsEvent>(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: { type: String, required: true, index: true },
    screen: { type: String, default: '', index: true },
    platform: { type: String, default: 'android' },
    props: { type: Schema.Types.Mixed, default: {} },
    created_at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

analyticsEventSchema.index({ created_at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });
analyticsEventSchema.index({ user_id: 1, created_at: -1 });
analyticsEventSchema.index({ name: 1, created_at: -1 });

const AnalyticsEvent: Model<IAnalyticsEvent> =
  mongoose.models.AnalyticsEvent ||
  mongoose.model<IAnalyticsEvent>('AnalyticsEvent', analyticsEventSchema);

export default AnalyticsEvent;
