// /qup-work-api/src/models/Payment.js
// Money moving through the app (marketplace escrow via Stripe Connect or Vipps).
// Flow: pending → held (customer paid, money waits) → released (paid out to pro)
import mongoose from 'mongoose';

const { Schema } = mongoose;

const paymentSchema = new Schema(
  {
    contract: { type: Schema.Types.ObjectId, ref: 'Contract', required: true },
    milestone: { type: Schema.Types.ObjectId, ref: 'Milestone' },
    invoice: { type: Schema.Types.ObjectId, ref: 'Invoice' },

    payer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    payee: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    amount: { type: Number, required: true, min: 1 }, // øre, what the customer pays
    platformFee: { type: Number, default: 0, min: 0 }, // øre, our cut
    currency: { type: String, default: 'NOK' },

    provider: { type: String, enum: ['stripe', 'vipps', 'manual'], required: true },
    providerRef: {
      stripePaymentIntentId: String,
      stripeTransferId: String,
      vippsReference: String,
    },

    status: {
      type: String,
      enum: ['pending', 'held', 'released', 'refunded', 'failed', 'cancelled'],
      default: 'pending',
    },
    heldAt: Date,
    releasedAt: Date,
    refundedAt: Date,
    failureReason: String,
  },
  { timestamps: true }
);

paymentSchema.virtual('payoutAmount').get(function () {
  return this.amount - (this.platformFee ?? 0);
});

paymentSchema.index({ contract: 1, createdAt: -1 });
paymentSchema.index({ payee: 1, status: 1 });
paymentSchema.index({ 'providerRef.stripePaymentIntentId': 1 }, { unique: true, sparse: true });
paymentSchema.index({ 'providerRef.vippsReference': 1 }, { unique: true, sparse: true });

paymentSchema.set('toJSON', { virtuals: true, versionKey: false });

export const Payment = mongoose.model('Payment', paymentSchema);
