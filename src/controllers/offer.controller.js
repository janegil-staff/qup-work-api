// /qup-work-api/src/controllers/offer.controller.js
// Offers (tilbud). Accepting an offer creates the Contract + Milestones.
import { Offer, Job, Contract, Milestone, Company, ProProfile } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { pick, getPagination, paginate } from '../utils/http.js';
import {
  assertCompanyRole, defaultCompanyId, isJobOwner, jobSide, loadJob, same,
} from '../utils/access.js';
import { notify } from '../utils/notify.js';
import { env } from '../config/env.js';

const OFFER_FIELDS = [
  'priceType', 'amount', 'estimatedHours', 'vatIncluded', 'message',
  'proposedMilestones', 'startDate', 'durationDays', 'validUntil',
];

async function loadOffer(req, offerId) {
  const offer = await Offer.findById(offerId);
  if (!offer) throw AppError.notFound('Offer');
  const job = await Job.findById(offer.job);
  if (!job) throw AppError.notFound('Offer');

  const isOfferPro = same(offer.pro, req.user._id);
  const isOwner = isJobOwner(job, await jobSide(req, job));
  if (!isOfferPro && !isOwner) throw AppError.notFound('Offer');
  return { offer, job, isOfferPro, isOwner };
}

const requirePending = (offer) => {
  if (offer.status !== 'pending') throw new AppError(`Offer is already ${offer.status}`, 409);
};

// POST /jobs/:jobId/offers
export const createOffer = async (req, res) => {
  const { job, side } = await loadJob(req, req.params.jobId, { allowViewer: true });
  const isMarketplaceBid = side === 'viewer';
  const isDirectQuote = job.source === 'direct' && side === 'pro'; // quote to my own client

  if (!isMarketplaceBid && !isDirectQuote) throw AppError.forbidden('You cannot send an offer on this job');
  if (job.contract || !['draft', 'open'].includes(job.status)) {
    throw new AppError('This job is no longer accepting offers', 409);
  }

  const company =
    req.body?.company ?? (isDirectQuote ? job.company : undefined) ?? (await defaultCompanyId(req));
  if (company) await assertCompanyRole(req, company);

  const offer = await Offer.create({
    ...pick(req.body, OFFER_FIELDS),
    job: job._id,
    pro: req.user._id,
    company,
  });
  await Job.updateOne({ _id: job._id }, { $inc: { offerCount: 1 } });

  await notify(job.customer, 'new_offer', 'Nytt tilbud', `${req.user.name} har sendt et tilbud på «${job.title}»`, {
    jobId: job._id,
    offerId: offer._id,
  });
  res.status(201).json({ offer });
};

// GET /jobs/:jobId/offers → job owner sees all, a pro sees only their own
export const listJobOffers = async (req, res) => {
  const { job, side } = await loadJob(req, req.params.jobId, { allowViewer: true });
  const filter = { job: job._id };
  if (!isJobOwner(job, side)) filter.pro = req.user._id;

  const offers = await Offer.find(filter)
    .sort({ createdAt: -1 })
    .populate('pro', 'name avatarUrl')
    .populate('company', 'name orgNumber logoUrl');

  // Attach rating + verification so the customer can compare offers
  const proIds = offers.map((o) => o.pro?._id).filter(Boolean);
  const profiles = await ProProfile.find({ user: { $in: proIds } })
    .select('user headline stats verification')
    .lean();
  const profileByUser = new Map(profiles.map((p) => [String(p.user), p]));

  res.json({
    offers: offers.map((o) => ({
      ...o.toJSON(),
      proProfile: profileByUser.get(String(o.pro?._id)) ?? null,
    })),
  });
};

// GET /offers/mine?status=pending
export const listMyOffers = async (req, res) => {
  const filter = { pro: req.user._id };
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };

  res.json(
    await paginate(Offer, filter, getPagination(req.query), {
      populate: { path: 'job', select: 'title status source address.city category publishedAt' },
    })
  );
};

// GET /offers/:offerId
export const getOffer = async (req, res) => {
  const { offer } = await loadOffer(req, req.params.offerId);
  await offer.populate([
    { path: 'pro', select: 'name avatarUrl' },
    { path: 'company', select: 'name orgNumber logoUrl' },
    { path: 'job', select: 'title status source' },
  ]);
  res.json({ offer });
};

// PATCH /offers/:offerId → the pro edits a pending offer
export const updateOffer = async (req, res) => {
  const { offer, isOfferPro } = await loadOffer(req, req.params.offerId);
  if (!isOfferPro) throw AppError.forbidden();
  requirePending(offer);

  offer.set(pick(req.body, OFFER_FIELDS));
  await offer.save();
  res.json({ offer });
};

// POST /offers/:offerId/withdraw
export const withdrawOffer = async (req, res) => {
  const { offer, job, isOfferPro } = await loadOffer(req, req.params.offerId);
  if (!isOfferPro) throw AppError.forbidden();
  requirePending(offer);

  offer.status = 'withdrawn';
  offer.respondedAt = new Date();
  await offer.save();
  await Job.updateOne({ _id: job._id, offerCount: { $gt: 0 } }, { $inc: { offerCount: -1 } });
  res.json({ offer });
};

// POST /offers/:offerId/accept → creates Contract + Milestones, rejects other offers
export const acceptOffer = async (req, res) => {
  const { offer, job, isOwner } = await loadOffer(req, req.params.offerId);
  if (!isOwner) throw AppError.forbidden('Only the job owner can accept offers');
  requirePending(offer);
  if (job.contract) throw new AppError('This job already has a contract', 409);

  if (offer.validUntil && offer.validUntil < new Date()) {
    offer.status = 'expired';
    await offer.save();
    throw new AppError('This offer has expired', 409);
  }

  const now = new Date();
  const companyId = offer.company ?? job.company;
  const company = companyId ? await Company.findById(companyId).select('vatRegistered') : null;
  const isHourly = offer.priceType === 'hourly';
  const total = isHourly ? undefined : offer.amount;

  // NB: without a MongoDB replica set we can't use transactions. The unique index on
  // Contract.job stops a job from ever getting two contracts if two requests race.
  const contract = await Contract.create({
    job: job._id,
    offer: offer._id,
    customer: job.customer,
    client: job.client,
    pro: offer.pro,
    company: companyId,
    title: job.title,
    description: job.description,
    priceType: offer.priceType,
    totalAmount: total,
    hourlyRate: isHourly ? offer.amount : undefined,
    vatRate: company?.vatRegistered ? 25 : 0,
    paymentMethod: job.source === 'marketplace' ? 'escrow' : 'invoice',
    platformFeePercent: job.source === 'marketplace' ? env.platformFeePercent : 0,
    startDate: offer.startDate,
    endDate:
      offer.startDate && offer.durationDays
        ? new Date(offer.startDate.getTime() + offer.durationDays * 86400000)
        : undefined,
  });

  const milestones = offer.proposedMilestones.length
    ? offer.proposedMilestones.map((m, i) => ({
        contract: contract._id,
        order: i + 1,
        title: m.title,
        description: m.description,
        amount: isHourly ? undefined : m.amount,
      }))
    : [{ contract: contract._id, order: 1, title: job.title, amount: total }];
  await Milestone.insertMany(milestones);

  offer.status = 'accepted';
  offer.respondedAt = now;
  await offer.save();

  const others = await Offer.find({ job: job._id, _id: { $ne: offer._id }, status: 'pending' }).select('pro');
  await Offer.updateMany(
    { _id: { $in: others.map((o) => o._id) } },
    { status: 'rejected', respondedAt: now }
  );

  job.set({
    status: 'assigned',
    pro: offer.pro,
    company: companyId,
    acceptedOffer: offer._id,
    contract: contract._id,
  });
  await job.save();

  if (!same(offer.pro, req.user._id)) {
    await notify(offer.pro, 'offer_accepted', 'Tilbudet ditt er akseptert! 🎉', `«${job.title}»`, {
      jobId: job._id,
      contractId: contract._id,
    });
  }
  for (const o of others) {
    await notify(o.pro, 'offer_rejected', 'Oppdraget gikk til en annen', `«${job.title}»`, { jobId: job._id });
  }

  res.status(201).json({ contract, offer });
};

// POST /offers/:offerId/reject
export const rejectOffer = async (req, res) => {
  const { offer, job, isOwner } = await loadOffer(req, req.params.offerId);
  if (!isOwner) throw AppError.forbidden('Only the job owner can reject offers');
  requirePending(offer);

  offer.status = 'rejected';
  offer.respondedAt = new Date();
  await offer.save();

  await notify(offer.pro, 'offer_rejected', 'Tilbudet ble avslått', `«${job.title}»`, { jobId: job._id });
  res.json({ offer });
};
