// /qup-work-api/src/controllers/milestone.controller.js
// Mounted at /contracts/:contractId/milestones
// Flow: pending → in_progress → submitted → approved
//                                         ↘ changes_requested → submitted ...
import { Milestone, Job } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { pick } from '../utils/http.js';
import { loadContract, requireActiveContract } from '../utils/access.js';
import { notify } from '../utils/notify.js';
import { cleanAttachments } from '../utils/uploads.js';

const MILESTONE_FIELDS = ['title', 'description', 'amount', 'dueDate'];

async function loadMilestone(req) {
  const { contract, side } = await loadContract(req, req.params.contractId);
  const milestone = await Milestone.findOne({ _id: req.params.milestoneId, contract: contract._id });
  if (!milestone) throw AppError.notFound('Milestone');
  return { contract, side, milestone };
}

const requirePro = (side) => {
  if (side !== 'pro') throw AppError.forbidden('Only the pro can do this');
};

const requireStatus = (milestone, allowed) => {
  if (!allowed.includes(milestone.status)) {
    throw new AppError(`Not possible while the milestone is ${milestone.status}`, 409);
  }
};

// Only photos uploaded through the app (see utils/uploads.js)
const withUploader = (attachments, uid) => cleanAttachments(attachments, uid);

const markJobInProgress = (jobId) =>
  Job.updateOne({ _id: jobId, status: 'assigned' }, { status: 'in_progress' });

// GET /contracts/:contractId/milestones
export const listMilestones = async (req, res) => {
  const { contract } = await loadContract(req, req.params.contractId);
  const milestones = await Milestone.find({ contract: contract._id }).sort({ order: 1 });
  res.json({ milestones });
};

// POST /contracts/:contractId/milestones
export const createMilestone = async (req, res) => {
  const { contract, side } = await loadContract(req, req.params.contractId);
  requirePro(side);
  requireActiveContract(contract);

  const last = await Milestone.findOne({ contract: contract._id }).sort({ order: -1 }).select('order');
  const milestone = await Milestone.create({
    ...pick(req.body, MILESTONE_FIELDS),
    contract: contract._id,
    order: (last?.order ?? 0) + 1,
  });
  res.status(201).json({ milestone });
};

// PATCH /contracts/:contractId/milestones/:milestoneId
export const updateMilestone = async (req, res) => {
  const { contract, side, milestone } = await loadMilestone(req);
  requirePro(side);
  requireActiveContract(contract);
  requireStatus(milestone, ['pending', 'in_progress', 'changes_requested']);

  milestone.set(pick(req.body, MILESTONE_FIELDS));
  await milestone.save();
  res.json({ milestone });
};

// DELETE /contracts/:contractId/milestones/:milestoneId (only pending)
export const deleteMilestone = async (req, res) => {
  const { contract, side, milestone } = await loadMilestone(req);
  requirePro(side);
  requireActiveContract(contract);
  requireStatus(milestone, ['pending']);
  await milestone.deleteOne();
  res.status(204).end();
};

// POST .../:milestoneId/start
export const startMilestone = async (req, res) => {
  const { contract, side, milestone } = await loadMilestone(req);
  requirePro(side);
  requireActiveContract(contract);
  requireStatus(milestone, ['pending', 'changes_requested']);

  milestone.status = 'in_progress';
  await milestone.save();
  await markJobInProgress(contract.job);
  res.json({ milestone });
};

// POST .../:milestoneId/attachments  { attachments: [{ url, kind, tag, ... }] }
// Progress photos while working (doesn't change status)
export const addAttachments = async (req, res) => {
  const { contract, side, milestone } = await loadMilestone(req);
  requirePro(side);
  requireActiveContract(contract);

  const attachments = withUploader(req.body?.attachments, req.user._id);
  if (!attachments.length) throw new AppError('attachments must be a non-empty array', 400);
  milestone.attachments.push(...attachments);
  await milestone.save();
  res.status(201).json({ milestone });
};

// POST .../:milestoneId/submit  { submissionNote, attachments }
export const submitMilestone = async (req, res) => {
  const { contract, side, milestone } = await loadMilestone(req);
  requirePro(side);
  requireActiveContract(contract);
  requireStatus(milestone, ['pending', 'in_progress', 'changes_requested']);

  milestone.attachments.push(...withUploader(req.body?.attachments, req.user._id));
  milestone.set({
    status: 'submitted',
    submissionNote: req.body?.submissionNote,
    submittedAt: new Date(),
  });
  await milestone.save();
  await markJobInProgress(contract.job);

  await notify(contract.customer, 'milestone_submitted', 'Arbeid levert til godkjenning', milestone.title, {
    contractId: contract._id,
    milestoneId: milestone._id,
    jobTitle: contract.title,
    stepTitle: milestone.title,
    actorName: req.user.name,
  });
  res.json({ milestone });
};

// POST .../:milestoneId/approve  { feedback, signature: { name, imageUrl, location } }
//   - the customer approves in their own app, or
//   - the customer signs on the pro's phone on site (signature required)
export const approveMilestone = async (req, res) => {
  const { contract, side, milestone } = await loadMilestone(req);
  requireActiveContract(contract);

  const signature = req.body?.signature;
  const isCustomer = side === 'customer';
  const isOnSiteSignature = side === 'pro' && signature;
  if (!isCustomer && !isOnSiteSignature) {
    throw AppError.forbidden('The customer must approve, or sign on site');
  }
  requireStatus(milestone, isCustomer ? ['submitted'] : ['in_progress', 'submitted']);

  milestone.set({
    status: 'approved',
    approvedAt: new Date(),
    approvedBy: req.user._id,
    feedback: req.body?.feedback,
  });
  if (signature) milestone.customerSignature = signature;
  await milestone.save();
  // TODO (payments step): release escrow payment for this milestone

  if (isCustomer) {
    await notify(contract.pro, 'milestone_approved', 'Arbeid godkjent ✅', milestone.title, {
      contractId: contract._id,
      milestoneId: milestone._id,
      jobTitle: contract.title,
      stepTitle: milestone.title,
      actorName: req.user.name,
    });
  }
  res.json({ milestone });
};

// POST .../:milestoneId/request-changes  { feedback }
export const requestChanges = async (req, res) => {
  const { contract, side, milestone } = await loadMilestone(req);
  if (side !== 'customer') throw AppError.forbidden('Only the customer can request changes');
  requireActiveContract(contract);
  requireStatus(milestone, ['submitted']);
  if (!req.body?.feedback) throw new AppError('feedback is required', 400);

  milestone.set({ status: 'changes_requested', feedback: req.body.feedback });
  await milestone.save();

  await notify(contract.pro, 'changes_requested', 'Kunden ønsker endringer', milestone.title, {
    contractId: contract._id,
    milestoneId: milestone._id,
    jobTitle: contract.title,
    stepTitle: milestone.title,
    actorName: req.user.name,
  });
  res.json({ milestone });
};
