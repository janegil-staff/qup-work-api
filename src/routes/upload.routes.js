// /qup-work-api/src/routes/upload.routes.js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getUploadSignature } from '../controllers/upload.controller.js';

const router = Router();
router.use(requireAuth);

router.post('/signature', getUploadSignature);

export default router;
