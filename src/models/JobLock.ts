import mongoose, { Schema, Model } from 'mongoose';

export interface IJobLock {
  _id: string;
  owner: string;
  expiresAt: Date;
}

const jobLockSchema = new Schema<IJobLock>({
  _id: { type: String },
  owner: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});

jobLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const JobLock: Model<IJobLock> =
  mongoose.models.JobLock || mongoose.model<IJobLock>('JobLock', jobLockSchema);

export default JobLock;
