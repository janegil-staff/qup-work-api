// /qup-work-api/src/models/Category.js
// Job/skill categories, e.g. "Elektriker" → "Sikringsskap", "Utvikling" → "Nettside".
import mongoose from 'mongoose';

const { Schema } = mongoose;

const categorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    parent: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    workType: { type: String, enum: ['onsite', 'remote', 'both'], default: 'onsite' },
    icon: String, // icon name for the apps
    description: String,
    requiresCertification: { type: Boolean, default: false }, // e.g. electrical work (DSB)
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

categorySchema.index({ parent: 1, sortOrder: 1 });

export const Category = mongoose.model('Category', categorySchema);
