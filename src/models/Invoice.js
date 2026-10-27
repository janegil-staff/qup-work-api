// /qup-work-api/src/models/Invoice.js
// Phase 1: the pro invoices their own client. Line prices are EXCLUDING VAT
// (normal for business invoices); totals are calculated automatically.
import mongoose from 'mongoose';
import { addressSchema } from './schemas/common.js';

const { Schema } = mongoose;

const lineSchema = new Schema(
  {
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, enum: ['stk', 'timer', 'm', 'm2', 'km', 'pakke'], default: 'stk' },
    unitPrice: { type: Number, required: true, min: 0 }, // øre excl. VAT
    vatRate: { type: Number, enum: [0, 12, 15, 25], default: 25 },
    amount: Number, // øre excl. VAT (calculated)
    vatAmount: Number, // øre (calculated)
    timeEntries: [{ type: Schema.Types.ObjectId, ref: 'TimeEntry' }], // hours billed on this line
  },
  { _id: true }
);

const invoiceSchema = new Schema(
  {
    company: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Assigned when the invoice is SENT (drafts have no number), so issued invoices
    // are numbered without gaps as Norwegian bookkeeping rules require.
    number: Number,
    kid: String, // KID number for bank payments, generated with the number

    client: { type: Schema.Types.ObjectId, ref: 'Client' },
    customer: { type: Schema.Types.ObjectId, ref: 'User' },
    contract: { type: Schema.Types.ObjectId, ref: 'Contract' },

    // Snapshot of the recipient at the time of invoicing
    billTo: {
      name: { type: String, required: true },
      orgNumber: String,
      email: String,
      address: addressSchema,
    },

    lines: {
      type: [lineSchema],
      validate: { validator: (v) => v.length > 0, message: 'An invoice needs at least one line' },
    },
    subtotal: Number, // øre excl. VAT
    vatTotal: Number, // øre
    total: Number, // øre incl. VAT

    issueDate: { type: Date, default: Date.now },
    dueDate: { type: Date, required: true },

    status: {
      type: String,
      enum: ['draft', 'sent', 'paid', 'overdue', 'cancelled', 'credited'],
      default: 'draft',
    },
    sentAt: Date,
    paidAt: Date,
    notes: { type: String, maxlength: 2000 },
    pdfUrl: String,
  },
  { timestamps: true }
);

invoiceSchema.pre('validate', function () {
  let subtotal = 0;
  let vatTotal = 0;
  for (const line of this.lines ?? []) {
    line.amount = Math.round(line.quantity * line.unitPrice);
    line.vatAmount = Math.round((line.amount * line.vatRate) / 100);
    subtotal += line.amount;
    vatTotal += line.vatAmount;
  }
  this.subtotal = subtotal;
  this.vatTotal = vatTotal;
  this.total = subtotal + vatTotal;

  if (this.dueDate && this.issueDate && this.dueDate < this.issueDate) {
    this.invalidate('dueDate', 'Due date cannot be before issue date');
  }
});

invoiceSchema.index(
  { company: 1, number: 1 },
  { unique: true, partialFilterExpression: { number: { $type: 'number' } } }
);
invoiceSchema.index({ company: 1, status: 1, dueDate: 1 });
invoiceSchema.index({ client: 1, issueDate: -1 });

invoiceSchema.virtual('isOverdue').get(function () {
  return ['sent', 'overdue'].includes(this.status) && this.dueDate < new Date();
});

invoiceSchema.set('toJSON', { virtuals: true, versionKey: false });

export const Invoice = mongoose.model('Invoice', invoiceSchema);
