// /qup-work-api/src/routes/review.routes.js
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  createReview, listUserReviews, replyToReview, hideReview,
} from '../controllers/review.controller.js';

const router = Router();

router.get('/user/:userId', listUserReviews); // public
router.post('/', requireAuth, createReview);
router.post('/:reviewId/reply', requireAuth, replyToReview);
router.post('/:reviewId/hide', requireAuth, requireRole('admin'), hideReview);

export default router;
