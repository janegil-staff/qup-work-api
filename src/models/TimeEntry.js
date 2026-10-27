// /qup-work-api/src/models/TimeEntry.js
// Hours worked. Started/stopped from the mobile app with GPS check-in/out.
import mongoose from 'mongoose';
import { pointSchema } from './schemas/common.js';

const { Schema } = mongoose;

const timeEntrySchema = new Schema(
  {
    contract: { type: Schema.Types.ObjectId, ref: 'Contract', required: true },
    milestone: { type: Schema.Types.ObjectId, ref: 'Milestone' },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true }, // who worked
    company: { type: Schema.Types.ObjectId, ref: 'Company' },

    startedAt: { type: Date, required: true },
    endedAt: Date, // empty while the timer is running
    minutes: { type: Number, min: 0 }, // calculated on save
    breakMinutes: { type: Number, default: 0, min: 0 },
    running: { type: Boolean, default: true }, // true while the timer is on (set on save)

    checkInLocation: pointSchema,
    checkOutLocation: pointSchema,

    note: { type: String, maxlength: 2000 },
    billable: { type: Boolean, default: true },
    hourlyRate: { type: Number, min: 0 }, // øre, copied from contract at the time
    invoice: { type: Schema.Types.ObjectId, ref: 'Invoice' }, // set once invoiced
  },
  { timestamps: true }
);

timeEntrySchema.pre('validate', function () {
  if (this.endedAt && this.endedAt <= this.startedAt) {
    this.invalidate('endedAt', 'End time must be after start time');
  }
});

timeEntrySchema.pre('save', function () {
  this.running = !this.endedAt;
  if (this.endedAt) {
    const total = Math.round((this.endedAt - this.startedAt) / 60000);
    this.minutes = Math.max(0, total - (this.breakMinutes ?? 0));
  }
});

timeEntrySchema.index({ user: 1, startedAt: -1 });
timeEntrySchema.index({ contract: 1, startedAt: -1 });
timeEntrySchema.index({ company: 1, startedAt: -1 });
// Only one running timer per user
timeEntrySchema.index(
  { user: 1, running: 1 },
  { unique: true, partialFilterExpression: { running: true } }
);

timeEntrySchema.set('toJSON', { versionKey: false });

export const TimeEntry = mongoose.model('TimeEntry', timeEntrySchema);
