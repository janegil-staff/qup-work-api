// /qup-work-api/src/routes/job.routes.js
import { Router } from 'express';
import { optionalAuth, requireAuth, requireRole } from '../middleware/auth.js';
import {
  createJob, listMyJobs, jobFeed, getJob, updateJob, publishJob, cancelJob, deleteJob,
} from '../controllers/job.controller.js';
import { createOffer, listJobOffers } from '../controllers/offer.controller.js';

const router = Router();

// Public: browse open jobs without logging in
router.get('/feed', optionalAuth, jobFeed); // must come before /:jobId
router.get('/:jobId', optionalAuth, getJob);

// Logged in
router.get('/', requireAuth, listMyJobs);
router.post('/', requireAuth, createJob);
router.patch('/:jobId', requireAuth, updateJob);
router.delete('/:jobId', requireAuth, deleteJob);
router.post('/:jobId/publish', requireAuth, publishJob);
router.post('/:jobId/cancel', requireAuth, cancelJob);

// Offers on a job
router.get('/:jobId/offers', requireAuth, listJobOffers);
router.post('/:jobId/offers', requireAuth, requireRole('pro'), createOffer);

export default router;
