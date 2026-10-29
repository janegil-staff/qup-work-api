// /qup-work-api/src/controllers/upload.controller.js
import { createUploadSignature } from '../utils/uploads.js';

// POST /uploads/signature  { purpose: 'milestone' | 'message' | 'avatar' | 'job' | 'signature' }
export const getUploadSignature = async (req, res) => {
  res.json(createUploadSignature(req.user._id.toString(), req.body?.purpose ?? 'milestone'));
};
