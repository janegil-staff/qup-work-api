// /qup-work-api/src/models/Offer.js
// A pro's quote (tilbud) on a job. Used both in the marketplace and when a pro
// sends a quote to their own client.
import mongoose from 'mongoose';

const { Schema } = mongoose;

const proposedMilestoneSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    description: String,
    amount: { type: Number, required: true, min: 0 }, // øre
  },
  { _id: false }
);

const offerSchema = new Schema(
  {
    job: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    pro: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    company: { type: Schema.Types.ObjectId, ref: 'Company' },

    priceType: { type: String, enum: ['fixed', 'hourly', 'estimate'], required: true },
    amount: { type: Number, required: true, min: 0 }, // øre: total for fixed/estimate, per hour for hourly
    estimatedHours: { type: Number, min: 0 },
    vatIncluded: { type: Boolean, default: true },

    message: { type: String, maxlength: 5000 },
    proposedMilestones: { type: [proposedMilestoneSchema], default: [] },

    startDate: Date,
    durationDays: { type: Number, min: 0 },
    validUntil: Date,

    status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected', 'withdrawn', 'expired'],
      default: 'pending',
    },
    respondedAt: Date,
  },
  { timestamps: true }
);

offerSchema.pre('validate', function () {
  if (this.proposedMilestones?.length && this.priceType !== 'hourly') {
    const sum = this.proposedMilestones.reduce((s, m) => s + m.amount, 0);
    if (sum !== this.amount) {
      this.invalidate('proposedMilestones', 'Milestone amounts must add up to the offer amount');
    }
  }
});

offerSchema.index({ job: 1, pro: 1 }, { unique: true }); // one offer per pro per job
offerSchema.index({ pro: 1, status: 1, createdAt: -1 });

// Estimated total in øre (hourly offers multiply by estimated hours)
offerSchema.virtual('estimatedTotal').get(function () {
  if (this.priceType === 'hourly') {
    return this.estimatedHours ? Math.round(this.amount * this.estimatedHours) : null;
  }
  return this.amount;
});

offerSchema.set('toJSON', { virtuals: true, versionKey: false });

export const Offer = mongoose.model('Offer', offerSchema);
