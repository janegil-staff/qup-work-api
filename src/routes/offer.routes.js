// /qup-work-api/src/routes/offer.routes.js
// Creating offers lives under /jobs/:jobId/offers (see job.routes.js)
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  listMyOffers, getOffer, updateOffer, withdrawOffer, acceptOffer, rejectOffer,
} from '../controllers/offer.controller.js';

const router = Router();
router.use(requireAuth);

router.get('/mine', listMyOffers); // must come before /:offerId
router.get('/:offerId', getOffer);
router.patch('/:offerId', updateOffer);
router.post('/:offerId/withdraw', withdrawOffer);
router.post('/:offerId/accept', acceptOffer);
router.post('/:offerId/reject', rejectOffer);

export default router;
