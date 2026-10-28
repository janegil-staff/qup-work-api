// /qup-work-api/src/utils/uploads.js
// Cloudinary signed uploads, and checking attachments before we store them.
//
// How an upload works:
//   1. app → POST /uploads/signature { purpose: 'milestone' }   → { signature, timestamp, folder, ... }
//   2. app → POST https://api.cloudinary.com/v1_1/<cloud>/image/upload with the file + those fields
//   3. app → sends { url, key } from Cloudinary's answer as an attachment (milestone, message)
// The signature only allows uploading into that user's folder, and only for about an hour.
import crypto from 'node:crypto';
import { env, cloudinaryReady } from '../config/env.js';
import { AppError } from './AppError.js';

export const UPLOAD_PURPOSES = ['milestone', 'message', 'avatar', 'job'];

// Cloudinary's rule: sort the params, join as a=1&b=2, append the secret, SHA-1 it
export function signParams(params, secret = env.cloudinary.apiSecret) {
  const toSign = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(toSign + secret).digest('hex');
}

export function createUploadSignature(userId, purpose = 'milestone') {
  if (!cloudinaryReady()) {
    throw new AppError('Photo uploads are not set up on the server (missing CLOUDINARY_* in .env)', 503);
  }
  if (!UPLOAD_PURPOSES.includes(purpose)) {
    throw new AppError(`purpose must be one of: ${UPLOAD_PURPOSES.join(', ')}`, 400);
  }
  const { cloudName, apiKey, folder: root } = env.cloudinary;
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `${root}/${purpose}/${userId}`;
  return {
    cloudName,
    apiKey,
    timestamp,
    folder,
    signature: signParams({ folder, timestamp }),
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`,
  };
}

const ATTACHMENT_FIELDS = ['url', 'key', 'kind', 'tag', 'name', 'mimeType', 'size', 'takenAt', 'location'];
const MAX_ATTACHMENTS = 10;

// Only files we uploaded ourselves: with Cloudinary set up, the URL must be in our cloud.
// (Without it, any https URL is allowed so local testing still works.)
export function cleanAttachments(list, uploadedBy) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new AppError('attachments must be an array', 400);
  if (list.length > MAX_ATTACHMENTS) throw new AppError(`At most ${MAX_ATTACHMENTS} attachments at a time`, 400);

  const prefix = cloudinaryReady() ? `https://res.cloudinary.com/${env.cloudinary.cloudName}/` : 'https://';
  return list.map((a) => {
    const url = typeof a?.url === 'string' ? a.url.trim() : '';
    if (!url.startsWith(prefix)) {
      throw new AppError('Attachments must be uploaded through the app', 400);
    }
    const clean = Object.fromEntries(ATTACHMENT_FIELDS.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
    return { ...clean, url, uploadedBy };
  });
}
