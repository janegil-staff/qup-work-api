// /qup-work-api/src/controllers/contract.controller.js
import { Contract, Job, Milestone, Company, ProProfile, Payment, TimeEntry } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { pick, getPagination, paginate } from '../utils/http.js';
import {
  getMyCompanyIds, loadContract, loadJob, requireActiveContract, same,
} from '../utils/access.js';
import { notify } from '../utils/notify.js';

const contractPopulate = [
  { path: 'customer', select: 'name avatarUrl phone email' },
  { path: 'client', select: 'name phone email address' },
  { path: 'pro', select: 'name avatarUrl phone' },
  { path: 'company', select: 'name orgNumber logoUrl' },
  { path: 'assignedWorkers', select: 'name avatarUrl' },
  { path: 'job', select: 'title address location status source' },
];

function assertWorkers(company, workerIds, uid) {
  for (const w of workerIds ?? []) {
    const ok = company ? company.getMemberRole(w) : same(w, uid);
    if (!ok) throw new AppError('Assigned workers must be members of the company', 400);
  }
}

// POST /contracts → for a DIRECT job (my own client), skipping the offer step
// { job, priceType, totalAmount, hourlyRate, vatRate, startDate, endDate, assignedWorkers,
//   milestones: [{ title, description, amount, dueDate }] }
export const createDirectContract = async (req, res) => {
  const body = req.body ?? {};
  const { job, side } = await loadJob(req, body.job);
  if (job.source !== 'direct' || side !== 'pro') {
    throw AppError.forbidden('Contracts can only be created directly for your own client jobs');
  }
  if (job.contract) throw new AppError('This job already has a contract', 409);
  if (['completed', 'cancelled'].includes(job.status)) throw new AppError(`Job is ${job.status}`, 409);

  const company = job.company ? await Company.findById(job.company) : null;
  assertWorkers(company, body.assignedWorkers, req.user._id);

  const milestoneInput = Array.isArray(body.milestones) ? body.milestones : [];
  if (body.priceType !== 'hourly' && milestoneInput.length) {
    const sum = milestoneInput.reduce((s, m) => s + (Number(m.amount) || 0), 0);
    if (sum !== Number(body.totalAmount)) {
      throw new AppError('Milestone amounts must add up to totalAmount', 400);
    }
  }

  const contract = await Contract.create({
    ...pick(body, ['priceType', 'totalAmount', 'hourlyRate', 'startDate', 'endDate', 'assignedWorkers']),
    job: job._id,
    client: job.client,
    customer: job.customer,
    pro: req.user._id,
    company: job.company,
    title: body.title ?? job.title,
    description: body.description ?? job.description,
    vatRate: body.vatRate ?? (company?.vatRegistered ? 25 : 0),
    paymentMethod: 'invoice',
  });

  const milestones = await Milestone.insertMany(
    milestoneInput.length
      ? milestoneInput.map((m, i) => ({
          ...pick(m, ['title', 'description', 'amount', 'dueDate']),
          contract: contract._id,
          order: i + 1,
        }))
      : [{ contract: contract._id, order: 1, title: contract.title, amount: contract.totalAmount }]
  );

  job.set({ status: 'assigned', contract: contract._id });
  await job.save();

  res.status(201).json({ contract, milestones });
};

// GET /contracts?role=customer|pro&status=active
export const listMyContracts = async (req, res) => {
  const uid = req.user._id;
  const role = req.query.role ?? req.user.activeRole;

  let filter;
  if (role === 'pro') {
    const ids = await getMyCompanyIds(req);
    filter = { $or: [{ pro: uid }, { assignedWorkers: uid }, { company: { $in: ids } }] };
  } else {
    filter = { customer: uid };
  }
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };

  res.json(
    await paginate(Contract, filter, getPagination(req.query), {
      sort: { updatedAt: -1 },
      populate: contractPopulate,
    })
  );
};

// GET /contracts/:contractId → contract + milestones + hours summary
export const getContract = async (req, res) => {
  const { contract, side } = await loadContract(req, req.params.contractId);

  const [milestones, [hours]] = await Promise.all([
    Milestone.find({ contract: contract._id }).sort({ order: 1 }),
    TimeEntry.aggregate([
      { $match: { contract: contract._id, running: false } },
      {
        $group: {
          _id: null,
          minutes: { $sum: '$minutes' },
          billableMinutes: { $sum: { $cond: ['$billable', '$minutes', 0] } },
        },
      },
    ]),
  ]);

  await contract.populate(contractPopulate);
  res.json({
    contract,
    side,
    milestones,
    hours: { minutes: hours?.minutes ?? 0, billableMinutes: hours?.billableMinutes ?? 0 },
  });
};

// PATCH /contracts/:contractId (pro side)
export const updateContract = async (req, res) => {
  const { contract, side } = await loadContract(req, req.params.contractId);
  if (side !== 'pro') throw AppError.forbidden();
  requireActiveContract(contract);

  const data = pick(req.body, ['title', 'description', 'startDate', 'endDate', 'assignedWorkers']);
  if (data.assignedWorkers) {
    const company = contract.company ? await Company.findById(contract.company) : null;
    assertWorkers(company, data.assignedWorkers, contract.pro);
  }
  contract.set(data);
  await contract.save();
  res.json({ contract });
};

// POST /contracts/:contractId/complete
// The customer completes it; for a client without an app account the pro does.
export const completeContract = async (req, res) => {
  const { contract, side } = await loadContract(req, req.params.contractId);
  const canComplete = side === 'customer' || (side === 'pro' && !contract.customer);
  if (!canComplete) throw AppError.forbidden('The customer completes this contract');
  requireActiveContract(contract);

  const open = await Milestone.countDocuments({
    contract: contract._id,
    status: { $nin: ['approved', 'cancelled'] },
  });
  if (open) throw new AppError(`${open} milestone(s) are not approved yet`, 409);

  const now = new Date();
  contract.status = 'completed';
  contract.completedAt = now;
  await contract.save();

  await Job.updateOne({ _id: contract.job }, { status: 'completed', closedAt: now });
  await ProProfile.updateOne({ user: contract.pro }, { $inc: { 'stats.completedJobs': 1 } });

  if (side === 'customer') {
    await notify(contract.pro, 'contract_completed', 'Oppdraget er fullført ✅', contract.title, {
      contractId: contract._id,
    });
  }
  res.json({ contract });
};

// POST /contracts/:contractId/cancel  { reason }
export const cancelContract = async (req, res) => {
  const { contract, side } = await loadContract(req, req.params.contractId);
  requireActiveContract(contract);

  if (await Payment.exists({ contract: contract._id, status: 'held' })) {
    throw new AppError('This contract has money held in escrow, it must be refunded first', 409);
  }

  const now = new Date();
  contract.set({ status: 'cancelled', cancelledAt: now, cancelReason: req.body?.reason });
  await contract.save();

  await Milestone.updateMany(
    { contract: contract._id, status: { $nin: ['approved', 'cancelled'] } },
    { status: 'cancelled' }
  );
  await Job.updateOne({ _id: contract.job }, { status: 'cancelled', closedAt: now });

  const other = side === 'customer' ? contract.pro : contract.customer;
  await notify(other, 'contract_cancelled', 'Oppdraget ble avbrutt', contract.title, {
    contractId: contract._id,
  });
  res.json({ contract });
};
