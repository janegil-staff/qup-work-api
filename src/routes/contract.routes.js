// /qup-work-api/src/routes/contract.routes.js
// Milestones live in milestone.routes.js (mounted at /contracts/:contractId/milestones)
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  createDirectContract, listMyContracts, getContract, updateContract, completeContract, cancelContract,
} from '../controllers/contract.controller.js';

const router = Router();
router.use(requireAuth);

router.get('/', listMyContracts);
router.post('/', requireRole('pro'), createDirectContract);
router.get('/:contractId', getContract);
router.patch('/:contractId', updateContract);
router.post('/:contractId/complete', completeContract);
router.post('/:contractId/cancel', cancelContract);

export default router;
