// /qup-work-api/src/controllers/job.controller.js
import { Job, Offer, Category } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { pick, getPagination, paginate, geoFilter, escapeRegex } from '../utils/http.js';
import {
  assertCompanyRole, defaultCompanyId, getMyCompanyIds, isJobOwner, loadClient, loadJob,
} from '../utils/access.js';
import { tryLookupPostcode } from '../utils/geo.js';
import { cleanAttachments } from '../utils/uploads.js';
import { notify } from '../utils/notify.js';
import { alertProsAboutJob } from '../utils/jobAlerts.js';

const JOB_FIELDS = [
  'title', 'description', 'category', 'workType', 'address', 'location', 'images', 'budget', 'timing',
];
const MARKETPLACE_FIELDS = ['visibility', 'invitedPros'];

const jobPopulate = [
  { path: 'category', select: 'name slug icon' },
  { path: 'client', select: 'name phone email address' },
  { path: 'customer', select: 'name avatarUrl' },
  { path: 'pro', select: 'name avatarUrl' },
];

// What everyone sees before a pro is hired: no street address, location rounded to ~1 km,
// only the customer's first name
function publicJobView(job) {
  const out = { ...job };
  if (out.address) out.address = { postalCode: out.address.postalCode, city: out.address.city, municipality: out.address.municipality };
  if (out.location?.coordinates) {
    out.location = {
      ...out.location,
      coordinates: out.location.coordinates.map((n) => Math.round(n * 100) / 100),
    };
  }
  if (out.customer?.name) {
    out.customer = { _id: out.customer._id, name: out.customer.name.split(' ')[0], avatarUrl: out.customer.avatarUrl };
  }
  delete out.invitedPros;
  delete out.client;
  return out;
}

// ?category=<id>,<id> → those categories plus their subcategories
async function categoryFilter(param) {
  const ids = String(param).split(',').filter(Boolean);
  const children = await Category.find({ parent: { $in: ids } }).select('_id').lean();
  return { $in: [...ids, ...children.map((c) => c._id)] };
}

// Only photos uploaded through the app (see utils/uploads.js)
const withUploader = (images, uid) => cleanAttachments(images, uid);

// On-site jobs with a postcode but no map position get one from Kartverket, so they
// show up in "near me" searches. If the lookup fails the job is saved without it.
async function fillPlaceFromPostcode(job) {
  if (job.workType === 'remote' || job.location?.coordinates?.length || !job.address?.postalCode) return;
  const place = await tryLookupPostcode(job.address.postalCode);
  if (!place) return;
  if (place.location) job.location = place.location;
  if (!job.address.city && place.city) job.set('address.city', place.city);
  if (!job.address.municipality && place.municipality) job.set('address.municipality', place.municipality);
}

// POST /jobs
//   with "client" → direct job (pro registers work for their own client)
//   without       → marketplace job (customer asks for offers)
export const createJob = async (req, res) => {
  const uid = req.user._id;
  const body = req.body ?? {};
  const data = pick(body, JOB_FIELDS);
  if (data.images) data.images = withUploader(data.images, uid);

  let job;
  if (body.client) {
    if (!req.user.roles.includes('pro')) throw AppError.forbidden('Only pros can create jobs for clients');
    const client = await loadClient(req, body.client);
    const company = body.company ?? client.company ?? (await defaultCompanyId(req));
    if (company) await assertCompanyRole(req, company);

    job = new Job({
      ...data,
      source: 'direct',
      createdBy: uid,
      client: client._id,
      pro: uid,
      company,
      visibility: 'private',
    });
    // Default to the client's address
    if (!data.address && client.address) job.address = client.address.toObject();
    if (!data.location && client.location) job.location = client.location.toObject();
  } else {
    job = new Job({
      ...data,
      ...pick(body, MARKETPLACE_FIELDS),
      source: 'marketplace',
      createdBy: uid,
      customer: uid,
    });
    if (!body.visibility) job.visibility = 'public';
  }

  await fillPlaceFromPostcode(job);
  await job.save();
  res.status(201).json({ job });
};

// GET /jobs?role=customer|pro&status=open,assigned&client=
export const listMyJobs = async (req, res) => {
  const uid = req.user._id;
  const role = req.query.role ?? req.user.activeRole;

  let filter;
  if (role === 'pro') {
    const ids = await getMyCompanyIds(req);
    filter = { $or: [{ pro: uid }, { company: { $in: ids } }] };
  } else {
    filter = { customer: uid };
  }
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  if (req.query.client) filter.client = req.query.client;

  res.json(
    await paginate(Job, filter, getPagination(req.query), {
      sort: { createdAt: -1 },
      populate: jobPopulate,
    })
  );
};

// GET /jobs/feed?q=&category=&workType=&lng=&lat=&radiusKm=   (public: open marketplace jobs)
// Logged in: also invited jobs, without my own jobs, and with myOfferStatus per job
export const jobFeed = async (req, res) => {
  const uid = req.user?._id;
  const filter = {
    source: 'marketplace',
    status: 'open',
    $or: uid
      ? [{ visibility: 'public' }, { visibility: 'invited', invitedPros: uid }]
      : [{ visibility: 'public' }],
  };
  if (uid) filter.customer = { $ne: uid };
  if (req.query.category) filter.category = await categoryFilter(req.query.category);
  if (req.query.workType) filter.workType = req.query.workType;
  if (req.query.q) filter.title = { $regex: escapeRegex(String(req.query.q)), $options: 'i' };
  Object.assign(filter, geoFilter(req.query, 'location') ?? {});

  const result = await paginate(Job, filter, getPagination(req.query), {
    sort: { publishedAt: -1 },
    populate: [
      { path: 'category', select: 'name slug icon' },
      { path: 'customer', select: 'name avatarUrl' },
    ],
  });

  // Tell the app which jobs I've already sent an offer on
  const myOffers = uid
    ? await Offer.find({ job: { $in: result.data.map((j) => j._id) }, pro: uid })
        .select('job status')
        .lean()
    : [];
  const offerByJob = new Map(myOffers.map((o) => [String(o.job), o.status]));

  result.data = result.data.map((j) => ({
    ...publicJobView(j.toJSON()),
    myOfferStatus: offerByJob.get(String(j._id)) ?? null,
  }));
  res.json(result);
};

// GET /jobs/:jobId   (public for open marketplace jobs)
// side: 'guest' | 'viewer' (logged in, not involved) | 'customer' | 'pro'
export const getJob = async (req, res) => {
  if (!req.user) {
    const job = await Job.findOne({
      _id: req.params.jobId,
      source: 'marketplace',
      status: 'open',
      visibility: 'public',
    }).populate(jobPopulate);
    if (!job) throw AppError.notFound('Job');
    return res.json({ job: publicJobView(job.toJSON()), side: 'guest', myOfferStatus: null, myOffer: null });
  }

  const { job, side } = await loadJob(req, req.params.jobId, { allowViewer: true });
  await job.populate(jobPopulate);
  const json = job.toJSON();

  const myOffer =
    side === 'viewer' ? await Offer.findOne({ job: job._id, pro: req.user._id }).select('status').lean() : null;

  res.json({
    job: side === 'viewer' ? publicJobView(json) : json,
    side,
    myOfferStatus: myOffer?.status ?? null,
    myOffer: myOffer ? { _id: myOffer._id, status: myOffer.status } : null,
  });
};

// PATCH /jobs/:jobId
export const updateJob = async (req, res) => {
  const { job, side } = await loadJob(req, req.params.jobId);
  if (!isJobOwner(job, side)) throw AppError.forbidden();
  if (!['draft', 'open'].includes(job.status)) {
    throw new AppError('A job can only be edited while it is a draft or open', 409);
  }

  const data = pick(req.body, JOB_FIELDS);
  if (data.images) data.images = withUploader(data.images, req.user._id);
  job.set(data);
  if (job.source === 'marketplace') job.set(pick(req.body, MARKETPLACE_FIELDS));
  if (data.address?.postalCode && !data.location) job.location = undefined; // moved: look it up again
  await fillPlaceFromPostcode(job);
  await job.save();
  res.json({ job });
};

// POST /jobs/:jobId/publish → marketplace: draft → open
export const publishJob = async (req, res) => {
  const { job, side } = await loadJob(req, req.params.jobId);
  if (job.source !== 'marketplace') throw new AppError('Only marketplace jobs can be published', 400);
  if (!isJobOwner(job, side)) throw AppError.forbidden();
  if (job.status !== 'draft') throw new AppError('Only draft jobs can be published', 409);
  // Without a category no pro gets told about the job, and it's hard to find
  if (!job.category) throw new AppError('Choose a category before publishing', 400, { category: 'required' });

  job.status = 'open';
  job.publishedAt = new Date();
  await job.save();
  // Pros nearby in this category hear about it (in the background, so publishing stays fast)
  alertProsAboutJob(job);
  res.json({ job });
};

// POST /jobs/:jobId/cancel
export const cancelJob = async (req, res) => {
  const { job, side } = await loadJob(req, req.params.jobId);
  if (!isJobOwner(job, side)) throw AppError.forbidden();
  if (job.contract) throw new AppError('This job has a contract, cancel the contract instead', 409);
  if (['completed', 'cancelled'].includes(job.status)) {
    throw new AppError(`Job is already ${job.status}`, 409);
  }

  job.status = 'cancelled';
  job.closedAt = new Date();
  await job.save();

  // Pros waiting for an answer hear that the job is gone
  const pending = await Offer.find({ job: job._id, status: 'pending' }).select('pro');
  await Offer.updateMany(
    { _id: { $in: pending.map((o) => o._id) } },
    { status: 'rejected', respondedAt: new Date() }
  );
  for (const o of pending) {
    await notify(o.pro, 'offer_rejected', 'Kunden avlyste oppdraget', `«${job.title}»`, {
      jobId: job._id,
      jobTitle: job.title,
      reason: 'job_cancelled',
    });
  }
  res.json({ job });
};

// DELETE /jobs/:jobId → only drafts
export const deleteJob = async (req, res) => {
  const { job, side } = await loadJob(req, req.params.jobId);
  if (!isJobOwner(job, side)) throw AppError.forbidden();
  if (job.status !== 'draft') throw new AppError('Only draft jobs can be deleted, cancel it instead', 409);
  await job.deleteOne();
  res.status(204).end();
};
