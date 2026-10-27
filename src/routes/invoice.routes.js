// /qup-work-api/src/routes/invoice.routes.js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  listInvoices, createInvoice, createInvoiceFromTime, getInvoice, updateInvoice,
  sendInvoice, markInvoicePaid, deleteInvoice,
} from '../controllers/invoice.controller.js';

const router = Router();
router.use(requireAuth);

router.get('/', listInvoices);
router.post('/', createInvoice);
router.post('/from-time', createInvoiceFromTime); // must come before /:invoiceId

router.get('/:invoiceId', getInvoice);
router.patch('/:invoiceId', updateInvoice);
router.delete('/:invoiceId', deleteInvoice);
router.post('/:invoiceId/send', sendInvoice);
router.post('/:invoiceId/mark-paid', markInvoicePaid);

export default router;
