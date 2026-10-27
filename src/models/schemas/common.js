// /qup-work-api/src/models/schemas/common.js
// Small reusable sub-schemas shared by several models.
//
// MONEY RULE: all amounts are integers in øre (NOK × 100).  1 250,00 kr → 125000
import mongoose from 'mongoose';

const { Schema } = mongoose;

// GeoJSON point. NB: coordinates are [longitude, latitude] (lng first!)
export const pointSchema = new Schema(
  {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: ([lng, lat]) =>
          lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90,
        message: 'Coordinates must be [longitude, latitude]',
      },
    },
  },
  { _id: false }
);

export const addressSchema = new Schema(
  {
    line1: { type: String, trim: true },
    line2: { type: String, trim: true },
    postalCode: { type: String, trim: true },
    city: { type: String, trim: true },
    municipality: { type: String, trim: true }, // kommune
    country: { type: String, default: 'NO' },
  },
  { _id: false }
);

// Photos, videos and files (before/after photos, drawings, deliverables, etc.)
export const attachmentSchema = new Schema(
  {
    url: { type: String, required: true },
    key: String, // storage key (S3/Cloudinary) so we can delete it later
    kind: { type: String, enum: ['image', 'video', 'document'], default: 'image' },
    tag: {
      type: String,
      enum: ['before', 'after', 'progress', 'document', 'deliverable', 'other'],
      default: 'other',
    },
    name: String,
    mimeType: String,
    size: Number, // bytes
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    takenAt: Date,
    location: pointSchema, // where the photo was taken (proof of work on site)
  },
  { _id: true, timestamps: { createdAt: true, updatedAt: false } }
);

// Signature drawn on the phone screen when a customer approves work
export const signatureSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    imageUrl: { type: String, required: true },
    signedAt: { type: Date, default: Date.now },
    location: pointSchema,
  },
  { _id: false }
);

export const ORG_NUMBER = [/^\d{9}$/, 'Org number must be 9 digits'];
