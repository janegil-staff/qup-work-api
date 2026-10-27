// /qup-work-api/src/routes/payment.routes.js
// Create / release / refund endpoints + Stripe & Vipps webhooks come in the payments step
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { listMyPayments, getPayment } from '../controllers/payment.controller.js';

const router = Router();
router.use(requireAuth);

router.get('/', listMyPayments);
router.get('/:paymentId', getPayment);

export default router;
