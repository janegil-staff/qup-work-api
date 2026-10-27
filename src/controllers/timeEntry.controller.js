// /qup-work-api/src/controllers/timeEntry.controller.js
// Timer in the app: POST /time-entries/start → POST /time-entries/stop
import { TimeEntry, Milestone, Job } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { pick, getPagination, paginate, toObjectId } from '../utils/http.js';
import {
  assertCompanyRole, loadContract, requireActiveContract, same,
} from '../utils/access.js';

async function loadProContract(req, contractId) {
  const { contract, side } = await loadContract(req, contractId);
  if (side !== 'pro') throw AppError.forbidden('Only the pro side can log hours');
  requireActiveContract(contract);
  return contract;
}

async function assertMilestone(milestoneId, contract) {
  if (!milestoneId) return;
  if (!(await Milestone.exists({ _id: milestoneId, contract: contract._id }))) {
    throw new AppError('Milestone does not belong to this contract', 400);
  }
}

// Own entries, or any entry in a company where I'm owner/admin
async function loadEditableEntry(req, entryId) {
  const entry = await TimeEntry.findById(entryId);
  if (!entry) throw AppError.notFound('Time entry');
  if (!same(entry.user, req.user._id)) {
    if (!entry.company) throw AppError.notFound('Time entry');
    await assertCompanyRole(req, entry.company, ['owner', 'admin']);
  }
  if (entry.invoice) throw new AppError('This entry is already invoiced', 409);
  return entry;
}

// POST /time-entries/start  { contract, milestone, location, note }
export const startTimer = async (req, res) => {
  const { contract: contractId, milestone, location, note } = req.body ?? {};
  const contract = await loadProContract(req, contractId);
  await assertMilestone(milestone, contract);

  const running = await TimeEntry.findOne({ user: req.user._id, running: true }).select('_id');
  if (running) {
    throw new AppError('You already have a running timer', 409, { runningEntryId: running._id });
  }

  const entry = await TimeEntry.create({
    contract: contract._id,
    milestone,
    user: req.user._id,
    company: contract.company,
    startedAt: new Date(),
    checkInLocation: location,
    note,
    hourlyRate: contract.hourlyRate,
  });
  await Job.updateOne({ _id: contract.job, status: 'assigned' }, { status: 'in_progress' });
  res.status(201).json({ entry });
};

// POST /time-entries/stop  { location, note, breakMinutes }
export const stopTimer = async (req, res) => {
  const entry = await TimeEntry.findOne({ user: req.user._id, running: true });
  if (!entry) throw AppError.notFound('Running timer');

  const { location, note, breakMinutes } = req.body ?? {};
  entry.endedAt = new Date();
  if (location) entry.checkOutLocation = location;
  if (note !== undefined) entry.note = note;
  if (breakMinutes !== undefined) entry.breakMinutes = breakMinutes;
  await entry.save(); // calculates minutes + sets running=false
  res.json({ entry });
};

// GET /time-entries/running
export const getRunningTimer = async (req, res) => {
  const entry = await TimeEntry.findOne({ user: req.user._id, running: true }).populate(
    'contract',
    'title'
  );
  res.json({ entry: entry ?? null });
};

// GET /time-entries?contract=&company=&user=&from=&to=&billable=&uninvoiced=true
//   no contract/company → my own hours
export const listTimeEntries = async (req, res) => {
  const { contract, company, user, from, to, billable, uninvoiced } = req.query;
  const filter = {};

  if (contract) {
    await loadContract(req, contract);
    filter.contract = toObjectId(contract, 'contract');
  } else if (company) {
    await assertCompanyRole(req, company, ['owner', 'admin']);
    filter.company = toObjectId(company, 'company');
  } else {
    filter.user = req.user._id;
  }
  if (user && (contract || company)) filter.user = toObjectId(user, 'user');

  if (from || to) {
    filter.startedAt = {};
    if (from) filter.startedAt.$gte = new Date(from);
    if (to) filter.startedAt.$lte = new Date(to);
  }
  if (billable !== undefined) filter.billable = billable === 'true';
  if (uninvoiced === 'true') filter.invoice = null;

  const [result, [totals]] = await Promise.all([
    paginate(TimeEntry, filter, getPagination(req.query), {
      sort: { startedAt: -1 },
      populate: [
        { path: 'user', select: 'name avatarUrl' },
        { path: 'contract', select: 'title' },
      ],
    }),
    TimeEntry.aggregate([
      { $match: { ...filter, running: false } },
      {
        $group: {
          _id: null,
          minutes: { $sum: '$minutes' },
          billableMinutes: { $sum: { $cond: ['$billable', '$minutes', 0] } },
        },
      },
    ]),
  ]);

  res.json({
    ...result,
    totals: { minutes: totals?.minutes ?? 0, billableMinutes: totals?.billableMinutes ?? 0 },
  });
};

// POST /time-entries → add hours manually  { contract, milestone, startedAt, endedAt, breakMinutes, note, billable }
export const createTimeEntry = async (req, res) => {
  const body = req.body ?? {};
  const contract = await loadProContract(req, body.contract);
  await assertMilestone(body.milestone, contract);
  if (!body.startedAt || !body.endedAt) throw new AppError('startedAt and endedAt are required', 400);

  const entry = await TimeEntry.create({
    ...pick(body, ['milestone', 'startedAt', 'endedAt', 'breakMinutes', 'note', 'billable']),
    contract: contract._id,
    user: req.user._id,
    company: contract.company,
    hourlyRate: contract.hourlyRate,
  });
  res.status(201).json({ entry });
};

// PATCH /time-entries/:entryId
export const updateTimeEntry = async (req, res) => {
  const entry = await loadEditableEntry(req, req.params.entryId);
  const data = pick(req.body, ['milestone', 'startedAt', 'endedAt', 'breakMinutes', 'note', 'billable']);
  if (data.milestone) await assertMilestone(data.milestone, { _id: entry.contract });

  entry.set(data);
  await entry.save();
  res.json({ entry });
};

// DELETE /time-entries/:entryId
export const deleteTimeEntry = async (req, res) => {
  const entry = await loadEditableEntry(req, req.params.entryId);
  await entry.deleteOne();
  res.status(204).end();
};
