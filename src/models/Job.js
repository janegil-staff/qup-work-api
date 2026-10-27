// /qup-work-api/src/models/Job.js
// A piece of work someone needs done.
//   source "direct"      → phase 1: a pro registers a job for their own client
//   source "marketplace" → phase 2: a customer posts a job and pros send offers
import mongoose from 'mongoose';
import { addressSchema, attachmentSchema, pointSchema } from './schemas/common.js';

const { Schema } = mongoose;

const jobSchema = new Schema(
  {
    source: { type: String, enum: ['direct', 'marketplace'], required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    // Who the work is for (one of these)
    customer: { type: Schema.Types.ObjectId, ref: 'User' }, // app user
    client: { type: Schema.Types.ObjectId, ref: 'Client' }, // pro's own client record

    // Who does the work (set directly for "direct", or when an offer is accepted)
    pro: { type: Schema.Types.ObjectId, ref: 'User' },
    company: { type: Schema.Types.ObjectId, ref: 'Company' },

    title: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, maxlength: 10000 },
    category: { type: Schema.Types.ObjectId, ref: 'Category' },
    workType: { type: String, enum: ['onsite', 'remote'], default: 'onsite' },

    address: addressSchema,
    location: pointSchema,
    images: { type: [attachmentSchema], default: [] },

    budget: {
      min: { type: Number, min: 0 }, // øre
      max: { type: Number, min: 0 }, // øre
    },
    timing: {
      urgency: {
        type: String,
        enum: ['asap', 'within_week', 'within_month', 'flexible'],
        default: 'flexible',
      },
      preferredStart: Date,
      preferredEnd: Date,
    },

    status: {
      type: String,
      enum: ['draft', 'open', 'assigned', 'in_progress', 'completed', 'cancelled'],
      default: 'draft',
    },
    visibility: { type: String, enum: ['public', 'invited', 'private'], default: 'private' },
    invitedPros: [{ type: Schema.Types.ObjectId, ref: 'User' }],

    offerCount: { type: Number, default: 0 },
    acceptedOffer: { type: Schema.Types.ObjectId, ref: 'Offer' },
    contract: { type: Schema.Types.ObjectId, ref: 'Contract' },

    publishedAt: Date,
    closedAt: Date,
  },
  { timestamps: true }
);

jobSchema.pre('validate', function () {
  if (!this.customer && !this.client) {
    this.invalidate('customer', 'A job needs either a customer or a client');
  }
  if (this.budget?.min != null && this.budget?.max != null && this.budget.min > this.budget.max) {
    this.invalidate('budget.max', 'Budget max must be at least budget min');
  }
});

jobSchema.index({ location: '2dsphere' });
jobSchema.index({ status: 1, visibility: 1, category: 1, publishedAt: -1 }); // marketplace feed
jobSchema.index({ customer: 1, createdAt: -1 });
jobSchema.index({ pro: 1, status: 1 });
jobSchema.index({ company: 1, status: 1 });
jobSchema.index({ client: 1 });

export const Job = mongoose.model('Job', jobSchema);
