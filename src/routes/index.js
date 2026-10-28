// /qup-work-api/src/routes/index.js
// Every feature router is mounted here under /api/v1
import { Router } from 'express';
import healthRoutes from './health.routes.js';
import authRoutes from './auth.routes.js';
import companyRoutes from './company.routes.js';
import categoryRoutes from './category.routes.js';
import proRoutes from './pro.routes.js';
import clientRoutes from './client.routes.js';
import jobRoutes from './job.routes.js';
import offerRoutes from './offer.routes.js';
import contractRoutes from './contract.routes.js';
import milestoneRoutes from './milestone.routes.js';
import timeEntryRoutes from './timeEntry.routes.js';
import conversationRoutes from './conversation.routes.js';
import reviewRoutes from './review.routes.js';
import invoiceRoutes from './invoice.routes.js';
import paymentRoutes from './payment.routes.js';
import notificationRoutes from './notification.routes.js';
import uploadRoutes from './upload.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/companies', companyRoutes);
router.use('/categories', categoryRoutes);
router.use('/pros', proRoutes);
router.use('/clients', clientRoutes);
router.use('/jobs', jobRoutes);
router.use('/offers', offerRoutes);
router.use('/contracts/:contractId/milestones', milestoneRoutes);
router.use('/contracts', contractRoutes);
router.use('/time-entries', timeEntryRoutes);
router.use('/conversations', conversationRoutes);
router.use('/reviews', reviewRoutes);
router.use('/invoices', invoiceRoutes);
router.use('/payments', paymentRoutes);
router.use('/notifications', notificationRoutes);
router.use('/uploads', uploadRoutes);

export default router;
