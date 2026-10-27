// /qup-work-api/src/models/Notification.js
// In-app inbox; the same record is also sent as an Expo push notification.
import mongoose from 'mongoose';

const { Schema } = mongoose;

const notificationSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: {
      type: String,
      required: true,
      enum: [
        'new_job_nearby',
        'new_offer',
        'offer_accepted',
        'offer_rejected',
        'new_message',
        'milestone_submitted',
        'milestone_approved',
        'changes_requested',
        'payment_received',
        'payment_released',
        'invoice_overdue',
        'new_review',
        'system',
      ],
    },
    title: { type: String, required: true },
    body: String,
    data: { type: Schema.Types.Mixed, default: {} }, // e.g. { jobId } so the app can deep-link
    readAt: Date,
    pushedAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

notificationSchema.index({ user: 1, readAt: 1, createdAt: -1 });
// Auto-delete after 90 days
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const Notification = mongoose.model('Notification', notificationSchema);
