// /qup-work-api/src/models/Conversation.js
// A chat thread between customer and pro, usually tied to a job.
import mongoose from 'mongoose';

const { Schema } = mongoose;

const conversationSchema = new Schema(
  {
    participants: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      validate: { validator: (v) => v.length >= 2, message: 'Need at least 2 participants' },
    },
    job: { type: Schema.Types.ObjectId, ref: 'Job' },
    contract: { type: Schema.Types.ObjectId, ref: 'Contract' },

    lastMessage: {
      text: String,
      sender: { type: Schema.Types.ObjectId, ref: 'User' },
      sentAt: Date,
    },
    unreadCounts: { type: Map, of: Number, default: {} }, // { userId: 3 }
  },
  { timestamps: true }
);

conversationSchema.index({ participants: 1, updatedAt: -1 }); // inbox
conversationSchema.index({ job: 1 });

export const Conversation = mongoose.model('Conversation', conversationSchema);
