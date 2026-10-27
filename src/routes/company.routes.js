// /qup-work-api/src/routes/company.routes.js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  createCompany, listMyCompanies, getCompany, updateCompany, addMember, updateMember, removeMember,
} from '../controllers/company.controller.js';

const router = Router();
router.use(requireAuth);

router.get('/', listMyCompanies);
router.post('/', createCompany);
router.get('/:companyId', getCompany);
router.patch('/:companyId', updateCompany);

router.post('/:companyId/members', addMember);
router.patch('/:companyId/members/:userId', updateMember);
router.delete('/:companyId/members/:userId', removeMember);

export default router;
