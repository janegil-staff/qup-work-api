// /qup-work-api/src/utils/jobAlerts.js
// When a marketplace job is published, tell the pros who could take it:
//   - visible on the marketplace and alerts not turned off (ProProfile.notifyNewJobs)
//   - offer the job's category, its main category or one of its subcategories
//   - on-site jobs: the job is inside their radius, or in a municipality they listed
//   - remote jobs: pros who work remotely, wherever they are
//   - invited jobs: only the invited pros, whatever their area
// Nearest first, at most MAX_PER_JOB pros, and nobody gets more than MAX_PER_HOUR an hour.
// Runs in the background; never throws.
import { Category, Notification, ProProfile } from '../models/index.js';
import { idOf, same } from './access.js';
import { notify } from './notify.js';

const MAX_PER_JOB = 50;
const MAX_PER_HOUR = 5;

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The job's category + its parent + its children, so "Elektriker" and "Elektriker > Lys" both match
async function relatedCategories(categoryId) {
  const cat = await Category.findById(categoryId).select('parent').lean();
  if (!cat) return [];
  const children = await Category.find({ parent: cat._id }).select('_id').lean();
  return [cat._id, cat.parent, ...children.map((c) => c._id)].filter(Boolean);
}

// [{ user, distanceKm? }] nearest first
async function findPros(job, categories) {
  const base = {
    availableForMarketplace: true,
    notifyNewJobs: { $ne: false },
    categories: { $in: categories },
    user: { $ne: idOf(job.customer) },
  };

  if (job.workType === 'remote') {
    const pros = await ProProfile.find({ ...base, workType: { $in: ['remote', 'both'] } })
      .sort({ 'stats.ratingAvg': -1 })
      .limit(MAX_PER_JOB * 2)
      .select('user')
      .lean();
    return pros.map((p) => ({ user: p.user }));
  }

  const onsite = { ...base, workType: { $in: ['onsite', 'both'] } };
  const found = new Map();

  // Inside the pro's own radius (each pro chooses how far they travel)
  const coords = job.location?.coordinates;
  if (coords?.length === 2) {
    const near = await ProProfile.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: coords },
          key: 'serviceArea.location',
          distanceField: 'distance',
          maxDistance: 1000 * 1000, // the largest radius a pro can choose
          query: onsite,
          spherical: true,
        },
      },
      { $match: { $expr: { $lte: ['$distance', { $multiply: [{ $ifNull: ['$serviceArea.radiusKm', 30] }, 1000] }] } } },
      { $limit: MAX_PER_JOB * 2 },
      { $project: { user: 1, distance: 1 } },
    ]);
    for (const p of near) found.set(String(p.user), { user: p.user, distanceKm: Math.round(p.distance / 100) / 10 });
  }

  // Or the municipality / town is on their list
  const places = [job.address?.municipality, job.address?.city].filter(Boolean);
  if (places.length) {
    const byPlace = await ProProfile.find({
      ...onsite,
      'serviceArea.municipalities': { $in: places.map((p) => new RegExp(`^${escapeRegex(p)}$`, 'i')) },
    })
      .limit(MAX_PER_JOB * 2)
      .select('user')
      .lean();
    for (const p of byPlace) if (!found.has(String(p.user))) found.set(String(p.user), { user: p.user });
  }

  // Nearest first; matched only by municipality goes last
  return [...found.values()].sort((a, b) => (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999));
}

// Pros who already got MAX_PER_HOUR job alerts in the last hour are skipped this time
async function withinHourlyLimit(userIds) {
  if (!userIds.length) return [];
  const busy = await Notification.aggregate([
    { $match: { user: { $in: userIds }, type: 'new_job_nearby', createdAt: { $gte: new Date(Date.now() - 3600 * 1000) } } },
    { $group: { _id: '$user', n: { $sum: 1 } } },
    { $match: { n: { $gte: MAX_PER_HOUR } } },
  ]);
  const skip = new Set(busy.map((b) => String(b._id)));
  return userIds.filter((id) => !skip.has(String(id)));
}

export async function alertProsAboutJob(job) {
  try {
    if (job.source !== 'marketplace' || job.status !== 'open') return 0;

    let targets;
    if (job.visibility === 'invited') {
      targets = (job.invitedPros ?? []).filter((p) => !same(p, job.customer)).map((user) => ({ user, invited: true }));
    } else {
      if (!job.category) return 0; // without a category we can't tell who it's for
      const categories = await relatedCategories(idOf(job.category));
      if (!categories.length) return 0;
      targets = await findPros(job, categories);
    }

    const allowed = new Set((await withinHourlyLimit(targets.map((t) => t.user))).map(String));
    const chosen = targets.filter((t) => allowed.has(String(t.user))).slice(0, MAX_PER_JOB);

    const place = job.workType === 'remote' ? null : job.address?.city ?? job.address?.municipality ?? null;
    for (const t of chosen) {
      await notify(t.user, 'new_job_nearby', 'Nytt oppdrag i nærheten', place ? `«${job.title}» i ${place}` : `«${job.title}»`, {
        jobId: job._id,
        jobTitle: job.title,
        place,
        remote: job.workType === 'remote',
        invited: Boolean(t.invited),
        distanceKm: t.distanceKm,
      });
    }
    if (chosen.length) console.log(`📣 job "${job.title}": ${chosen.length} pro(s) notified`);
    return chosen.length;
  } catch (err) {
    console.error('job alerts failed:', err.message);
    return 0;
  }
}
