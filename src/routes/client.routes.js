// /qup-work-api/src/routes/client.routes.js
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  listClients, createClient, getClient, updateClient, deleteClient,
} from '../controllers/client.controller.js';

const router = Router();
router.use(requireAuth, requireRole('pro'));

router.get('/', listClients);
router.post('/', createClient);
router.get('/:clientId', getClient);
router.patch('/:clientId', updateClient);
router.delete('/:clientId', deleteClient);

export default router;
