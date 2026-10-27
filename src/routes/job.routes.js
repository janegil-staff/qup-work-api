// /qup-work-api/src/routes/job.routes.js
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  createJob, listMyJobs, jobFeed, getJob, updateJob, publishJob, cancelJob, deleteJob,
} from '../controllers/job.controller.js';
import { createOffer, listJobOffers } from '../controllers/offer.controller.js';

const router = Router();
router.use(requireAuth);

router.get('/', listMyJobs);
router.post('/', createJob);
router.get('/feed', requireRole('pro'), jobFeed); // must come before /:jobId

router.get('/:jobId', getJob);
router.patch('/:jobId', updateJob);
router.delete('/:jobId', deleteJob);
router.post('/:jobId/publish', publishJob);
router.post('/:jobId/cancel', cancelJob);

// Offers on a job
router.get('/:jobId/offers', listJobOffers);
router.post('/:jobId/offers', requireRole('pro'), createOffer);

export default router;
