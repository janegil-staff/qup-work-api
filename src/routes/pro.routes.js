// /qup-work-api/src/routes/pro.routes.js
import { Router } from 'express';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import {
  searchPros, getMyProProfile, upsertMyProProfile, getPro,
} from '../controllers/pro.controller.js';

const router = Router();

router.get('/', optionalAuth, searchPros); // public search
router.get('/me', requireAuth, getMyProProfile); // must come before /:userId
router.put('/me', requireAuth, upsertMyProProfile);
router.get('/:userId', optionalAuth, getPro); // public profile

export default router;
