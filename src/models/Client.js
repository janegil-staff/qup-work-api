// /qup-work-api/src/models/Client.js
// Phase 1: a pro's own customer who isn't (yet) a user of the app.
// If that person later signs up, link them via `user`.
import mongoose from 'mongoose';
import { addressSchema, pointSchema, ORG_NUMBER } from './schemas/common.js';

const { Schema } = mongoose;

const clientSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true }, // pro who created it
    company: { type: Schema.Types.ObjectId, ref: 'Company' }, // shared within the company

    type: { type: String, enum: ['private', 'business'], default: 'private' },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    contactPerson: { type: String, trim: true }, // for business clients
    orgNumber: { type: String, trim: true, match: ORG_NUMBER },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    address: addressSchema,
    location: pointSchema,

    user: { type: Schema.Types.ObjectId, ref: 'User' }, // linked app account, if any
    notes: { type: String, maxlength: 5000 },
    tags: { type: [String], default: [] },
    archived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

clientSchema.index({ company: 1, name: 1 });
clientSchema.index({ owner: 1, name: 1 });
clientSchema.index({ name: 'text', email: 'text', phone: 'text' });

export const Client = mongoose.model('Client', clientSchema);
