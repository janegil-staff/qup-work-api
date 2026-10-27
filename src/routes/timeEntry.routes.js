// /qup-work-api/src/routes/timeEntry.routes.js
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  startTimer, stopTimer, getRunningTimer, listTimeEntries, createTimeEntry,
  updateTimeEntry, deleteTimeEntry,
} from '../controllers/timeEntry.controller.js';

const router = Router();
router.use(requireAuth);

router.get('/', listTimeEntries);
router.get('/running', getRunningTimer); // these must come before /:entryId
router.post('/start', requireRole('pro'), startTimer);
router.post('/stop', stopTimer);

router.post('/', requireRole('pro'), createTimeEntry);
router.patch('/:entryId', updateTimeEntry);
router.delete('/:entryId', deleteTimeEntry);

export default router;
