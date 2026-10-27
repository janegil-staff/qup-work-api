// /qup-work-api/src/utils/http.js
// Small helpers used by most controllers.
import mongoose from 'mongoose';
import { AppError } from './AppError.js';

// Only copy allowed fields from req.body (never trust the whole body)
export function pick(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// Update some keys of a nested object without wiping the others
//   setNested(company, 'invoiceSettings', req.body.invoiceSettings, ['bankAccount'])
export function setNested(doc, path, obj, keys) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of keys) if (obj[k] !== undefined) doc.set(`${path}.${k}`, obj[k]);
}

// ?page=2&limit=20
export function getPagination(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

export async function paginate(Model, filter, { page, limit, skip }, options = {}) {
  const { sort = { createdAt: -1 }, populate, select } = options;
  let query = Model.find(filter).sort(sort).skip(skip).limit(limit);
  if (select) query = query.select(select);
  if (populate) query = query.populate(populate);

  const [data, total] = await Promise.all([query, Model.countDocuments(filter)]);
  return { data, page, limit, total, pages: Math.ceil(total / limit) };
}

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const isObjectIdString = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);

// Needed in aggregate() pipelines, where Mongoose does not convert strings to ObjectIds
export function toObjectId(value, field = 'id') {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (!isObjectIdString(String(value))) throw new AppError(`Invalid ${field}`, 400);
  return new mongoose.Types.ObjectId(String(value));
}

// ?lng=5.32&lat=60.39&radiusKm=30 → Mongo filter for a GeoJSON field
export function geoFilter(query, field) {
  const { lng, lat, radiusKm = 50 } = query;
  if (lng === undefined && lat === undefined) return null;
  const x = Number(lng);
  const y = Number(lat);
  const r = Number(radiusKm);
  if (![x, y, r].every(Number.isFinite) || r <= 0) {
    throw new AppError('lng, lat and radiusKm must be valid numbers', 400);
  }
  return { [field]: { $geoWithin: { $centerSphere: [[x, y], r / 6378.1] } } };
}

export function slugify(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const addDays = (date, days) => new Date(date.getTime() + days * 86400000);
