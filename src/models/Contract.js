// /qup-work-api/src/models/Contract.js
// The agreement once a job is assigned. Work is tracked through Milestones and
// TimeEntries, and paid through Payments or Invoices.
import mongoose from 'mongoose';

const { Schema } = mongoose;

const contractSchema = new Schema(
  {
    job: { type: Schema.Types.ObjectId, ref: 'Job', required: true, unique: true },
    offer: { type: Schema.Types.ObjectId, ref: 'Offer' },

    customer: { type: Schema.Types.ObjectId, ref: 'User' },
    client: { type: Schema.Types.ObjectId, ref: 'Client' },
    pro: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    company: { type: Schema.Types.ObjectId, ref: 'Company' },
    assignedWorkers: [{ type: Schema.Types.ObjectId, ref: 'User' }], // company employees on the job

    title: { type: String, required: true, trim: true },
    description: String,

    priceType: { type: String, enum: ['fixed', 'hourly', 'estimate'], required: true },
    // Contract prices are what the customer pays, i.e. INCLUDING VAT
    totalAmount: { type: Number, min: 0 }, // øre (fixed/estimate)
    hourlyRate: { type: Number, min: 0 }, // øre (hourly)
    currency: { type: String, default: 'NOK' },
    vatRate: { type: Number, enum: [0, 12, 15, 25], default: 25 },

    // escrow = paid through the app (marketplace), invoice = pro invoices directly
    paymentMethod: { type: String, enum: ['escrow', 'invoice'], default: 'invoice' },
    platformFeePercent: { type: Number, default: 0, min: 0, max: 50 },

    status: {
      type: String,
      enum: ['active', 'completed', 'cancelled', 'disputed'],
      default: 'active',
    },
    startDate: Date,
    endDate: Date,
    completedAt: Date,
    cancelledAt: Date,
    cancelReason: String,
  },
  { timestamps: true }
);

contractSchema.pre('validate', function () {
  if (!this.customer && !this.client) {
    this.invalidate('customer', 'A contract needs either a customer or a client');
  }
  if (this.priceType === 'hourly' && this.hourlyRate == null) {
    this.invalidate('hourlyRate', 'Hourly contracts need an hourly rate');
  }
  if (this.priceType !== 'hourly' && this.totalAmount == null) {
    this.invalidate('totalAmount', 'Fixed/estimate contracts need a total amount');
  }
});

contractSchema.index({ pro: 1, status: 1 });
contractSchema.index({ company: 1, status: 1 });
contractSchema.index({ customer: 1, status: 1 });
contractSchema.index({ assignedWorkers: 1, status: 1 });

export const Contract = mongoose.model('Contract', contractSchema);
