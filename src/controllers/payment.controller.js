// /qup-work-api/src/controllers/payment.controller.js
// Read-only for now. Creating, holding and releasing payments comes with the
// Stripe Connect / Vipps step, since those are driven by the providers' webhooks.
import { Payment } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { getPagination, paginate } from '../utils/http.js';
import { same } from '../utils/access.js';

// GET /payments?status=held
export const listMyPayments = async (req, res) => {
  const filter = { $or: [{ payer: req.user._id }, { payee: req.user._id }] };
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };

  res.json(
    await paginate(Payment, filter, getPagination(req.query), {
      populate: [
        { path: 'contract', select: 'title' },
        { path: 'milestone', select: 'title' },
      ],
    })
  );
};

// GET /payments/:paymentId
export const getPayment = async (req, res) => {
  const payment = await Payment.findById(req.params.paymentId).populate([
    { path: 'contract', select: 'title' },
    { path: 'milestone', select: 'title' },
    { path: 'payer', select: 'name' },
    { path: 'payee', select: 'name' },
  ]);
  if (!payment || !(same(payment.payer, req.user._id) || same(payment.payee, req.user._id))) {
    throw AppError.notFound('Payment');
  }
  res.json({ payment });
};
