// /qup-work-api/src/routes/index.js
import { Router } from 'express';
import healthRoutes from './health.routes.js';

const router = Router();

router.use('/health', healthRoutes);

// Next steps:
// router.use('/auth', authRoutes);
// router.use('/jobs', jobRoutes);

export default router;
