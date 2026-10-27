// /qup-work-api/src/models/Company.js
// The pro's business (ENK, AS, ...). A solo pro is simply a company with one member.
// Clients, contracts and invoices belong to a company.
import mongoose from 'mongoose';
import { addressSchema, ORG_NUMBER } from './schemas/common.js';

const { Schema } = mongoose;

const memberSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['owner', 'admin', 'worker'], default: 'worker' },
    hourlyCost: { type: Number, min: 0 }, // øre, internal cost per hour (for profit reports)
  },
  { _id: false, timestamps: { createdAt: 'joinedAt', updatedAt: false } }
);

const companySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    orgNumber: { type: String, trim: true, match: ORG_NUMBER },
    orgForm: { type: String, enum: ['ENK', 'AS', 'ANS', 'DA', 'NUF', 'other'] },
    vatRegistered: { type: Boolean, default: false }, // MVA-registrert

    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    members: { type: [memberSchema], default: [] },

    email: { type: String, lowercase: true, trim: true },
    phone: String,
    website: String,
    logoUrl: String,
    address: addressSchema,

    invoiceSettings: {
      nextInvoiceNumber: { type: Number, default: 1 },
      paymentTermsDays: { type: Number, default: 14 },
      bankAccount: String, // kontonummer printed on invoices
      footerText: String,
    },

    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true }
);

companySchema.index({ orgNumber: 1 }, { unique: true, sparse: true });
companySchema.index({ 'members.user': 1 });

companySchema.methods.getMemberRole = function (userId) {
  const idOf = (v) => String(v?._id ?? v); // works whether members.user is populated or not
  const m = this.members.find((x) => idOf(x.user) === idOf(userId));
  return m?.role ?? null;
};

export const Company = mongoose.model('Company', companySchema);
