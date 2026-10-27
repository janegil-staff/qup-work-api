// /qup-work-api/src/models/Milestone.js
// A step in a contract. Small on-site jobs have one milestone; bigger jobs or
// software projects have several, each approved (and paid) separately.
import mongoose from 'mongoose';
import { attachmentSchema, signatureSchema } from './schemas/common.js';

const { Schema } = mongoose;

const milestoneSchema = new Schema(
  {
    contract: { type: Schema.Types.ObjectId, ref: 'Contract', required: true },
    order: { type: Number, required: true, min: 1 },

    title: { type: String, required: true, trim: true },
    description: String,
    amount: { type: Number, min: 0 }, // øre (empty for hourly contracts)
    dueDate: Date,

    status: {
      type: String,
      enum: ['pending', 'in_progress', 'submitted', 'changes_requested', 'approved', 'cancelled'],
      default: 'pending',
    },

    // Pro submits: photos / deliverables + a note
    attachments: { type: [attachmentSchema], default: [] },
    submissionNote: String,
    submittedAt: Date,

    // Customer responds
    feedback: String,
    approvedAt: Date,
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    customerSignature: signatureSchema, // signed on the pro's phone on site

    payment: { type: Schema.Types.ObjectId, ref: 'Payment' },
  },
  { timestamps: true }
);

milestoneSchema.index({ contract: 1, order: 1 }, { unique: true });
milestoneSchema.index({ status: 1, dueDate: 1 });

export const Milestone = mongoose.model('Milestone', milestoneSchema);
