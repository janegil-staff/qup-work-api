// /qup-work-api/src/models/ProProfile.js
// Public-facing profile for a user with the "pro" role.
import mongoose from 'mongoose';
import { attachmentSchema, pointSchema } from './schemas/common.js';

const { Schema } = mongoose;

const certificateSchema = new Schema(
  {
    name: { type: String, required: true }, // e.g. "Fagbrev elektriker"
    issuer: String,
    number: String,
    expiresAt: Date,
    fileUrl: String,
    verified: { type: Boolean, default: false },
  },
  { _id: true }
);

const proProfileSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    company: { type: Schema.Types.ObjectId, ref: 'Company' },

    headline: { type: String, trim: true, maxlength: 120 }, // "Elektriker i Bergen, 15 års erfaring"
    bio: { type: String, maxlength: 3000 },
    categories: [{ type: Schema.Types.ObjectId, ref: 'Category' }],
    skills: { type: [String], default: [] },
    languages: { type: [String], default: ['no'] },
    workType: { type: String, enum: ['onsite', 'remote', 'both'], default: 'onsite' },

    serviceArea: {
      location: pointSchema, // base location
      radiusKm: { type: Number, default: 30, min: 1, max: 1000 },
      municipalities: { type: [String], default: [] },
    },

    hourlyRate: { type: Number, min: 0 }, // øre, incl. VAT, shown as "fra X kr/t"
    portfolio: { type: [attachmentSchema], default: [] },
    certificates: { type: [certificateSchema], default: [] },

    verification: {
      orgNumberVerified: { type: Boolean, default: false }, // checked against Brønnøysund
      identityVerified: { type: Boolean, default: false }, // BankID later
    },

    // Phase 2: only pros with this on show up in the marketplace
    availableForMarketplace: { type: Boolean, default: false },

    stats: {
      ratingAvg: { type: Number, default: 0 },
      ratingCount: { type: Number, default: 0 },
      completedJobs: { type: Number, default: 0 },
      responseTimeMinutes: Number,
    },
  },
  { timestamps: true }
);

proProfileSchema.index({ 'serviceArea.location': '2dsphere' });
proProfileSchema.index({ categories: 1, availableForMarketplace: 1 });
proProfileSchema.index({ headline: 'text', bio: 'text', skills: 'text' });

export const ProProfile = mongoose.model('ProProfile', proProfileSchema);
