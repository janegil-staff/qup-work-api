// /qup-work-api/src/controllers/pro.controller.js
import { ProProfile, User, Review, Category } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { pick, setNested, getPagination, paginate, geoFilter, escapeRegex } from '../utils/http.js';
import { assertCompanyRole } from '../utils/access.js';

const PROFILE_FIELDS = [
  'headline', 'bio', 'categories', 'skills', 'languages', 'workType',
  'hourlyRate', 'availableForMarketplace', 'portfolio', 'certificates', 'company',
];

const profilePopulate = [
  { path: 'categories', select: 'name slug icon' },
  { path: 'company', select: 'name orgNumber logoUrl' },
];

// GET /pros/me
export const getMyProProfile = async (req, res) => {
  const profile = await ProProfile.findOne({ user: req.user._id }).populate(profilePopulate);
  if (!profile) throw AppError.notFound('Pro profile');
  res.json({ profile });
};

// PUT /pros/me → create or update my pro profile
export const upsertMyProProfile = async (req, res) => {
  const uid = req.user._id;
  const data = pick(req.body, PROFILE_FIELDS);
  if (data.company) await assertCompanyRole(req, data.company);

  let profile = await ProProfile.findOne({ user: uid });
  const isNew = !profile;
  if (isNew) profile = new ProProfile({ user: uid });

  // Users can't verify their own certificates; keep the flag for ones that already exist
  if (Array.isArray(data.certificates)) {
    const verified = new Map(profile.certificates.map((c) => [c._id.toString(), c.verified]));
    data.certificates = data.certificates.map((c) => ({
      ...c,
      verified: verified.get(String(c._id)) ?? false,
    }));
  }
  if (Array.isArray(data.portfolio)) {
    data.portfolio = data.portfolio.map((a) => ({ ...a, uploadedBy: uid }));
  }

  profile.set(data);
  setNested(profile, 'serviceArea', req.body?.serviceArea, ['location', 'radiusKm', 'municipalities']);
  await profile.save();

  await User.updateOne({ _id: uid }, { $addToSet: { roles: 'pro' } });
  await profile.populate(profilePopulate);
  res.status(isNew ? 201 : 200).json({ profile });
};

// GET /pros?category=&lng=&lat=&radiusKm=&q=&workType=   (public)
export const searchPros = async (req, res) => {
  const { category, q, workType } = req.query;
  const filter = { availableForMarketplace: true };

  if (category) {
    // the category itself + its subcategories
    const ids = String(category).split(',').filter(Boolean);
    const children = await Category.find({ parent: { $in: ids } }).select('_id').lean();
    filter.categories = { $in: [...ids, ...children.map((c) => c._id)] };
  }
  if (workType) filter.workType = { $in: [workType, 'both'] };
  if (q) {
    // partial match, so "elektr" finds "Elektriker"
    const re = { $regex: escapeRegex(String(q)), $options: 'i' };
    filter.$or = [{ headline: re }, { skills: re }, { bio: re }, { 'serviceArea.municipalities': re }];
  }
  Object.assign(filter, geoFilter(req.query, 'serviceArea.location') ?? {});

  const result = await paginate(ProProfile, filter, getPagination(req.query), {
    sort: { 'stats.ratingAvg': -1, 'stats.ratingCount': -1 },
    populate: [{ path: 'user', select: 'name avatarUrl' }, ...profilePopulate],
    select: '-certificates.number -certificates.fileUrl',
  });
  res.json(result);
};

// GET /pros/:userId   (public)
export const getPro = async (req, res) => {
  const profile = await ProProfile.findOne({ user: req.params.userId })
    .select('-certificates.number -certificates.fileUrl')
    .populate([{ path: 'user', select: 'name avatarUrl createdAt' }, ...profilePopulate]);

  const isMe = Boolean(req.user && profile?.user && req.user._id.equals(profile.user._id));
  if (!profile || (!profile.availableForMarketplace && !isMe)) throw AppError.notFound('Pro');

  const reviews = await Review.find({
    reviewee: req.params.userId,
    direction: 'customer_to_pro',
    visible: true,
  })
    .sort({ createdAt: -1 })
    .limit(5)
    .populate('reviewer', 'name avatarUrl');

  res.json({ profile, reviews });
};
