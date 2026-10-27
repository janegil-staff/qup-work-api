// /qup-work-api/src/routes/milestone.routes.js
// Mounted at /contracts/:contractId/milestones
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  listMilestones, createMilestone, updateMilestone, deleteMilestone, startMilestone,
  addAttachments, submitMilestone, approveMilestone, requestChanges,
} from '../controllers/milestone.controller.js';

const router = Router({ mergeParams: true }); // gives access to req.params.contractId
router.use(requireAuth);

router.get('/', listMilestones);
router.post('/', createMilestone);
router.patch('/:milestoneId', updateMilestone);
router.delete('/:milestoneId', deleteMilestone);

router.post('/:milestoneId/start', startMilestone);
router.post('/:milestoneId/attachments', addAttachments);
router.post('/:milestoneId/submit', submitMilestone);
router.post('/:milestoneId/approve', approveMilestone);
router.post('/:milestoneId/request-changes', requestChanges);

export default router;
