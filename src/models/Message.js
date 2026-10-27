// /qup-work-api/src/models/Message.js
import mongoose from 'mongoose';
import { attachmentSchema } from './schemas/common.js';

const { Schema } = mongoose;

const messageSchema = new Schema(
  {
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    sender: { type: Schema.Types.ObjectId, ref: 'User' }, // empty for system messages
    type: { type: String, enum: ['text', 'system', 'offer'], default: 'text' },

    text: { type: String, maxlength: 5000 },
    attachments: { type: [attachmentSchema], default: [] },
    offer: { type: Schema.Types.ObjectId, ref: 'Offer' }, // for type "offer"

    readBy: {
      type: [
        new Schema(
          {
            user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
            readAt: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { timestamps: true }
);

messageSchema.pre('validate', function () {
  if (this.type === 'text' && !this.text && !this.attachments?.length) {
    this.invalidate('text', 'A message needs text or an attachment');
  }
});

messageSchema.index({ conversation: 1, createdAt: -1 });

export const Message = mongoose.model('Message', messageSchema);
