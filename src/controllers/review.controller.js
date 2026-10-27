// /qup-work-api/src/controllers/review.controller.js
import { Review } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { getPagination, paginate } from '../utils/http.js';
import { loadContract, same } from '../utils/access.js';
import { notify } from '../utils/notify.js';

// POST /reviews  { contract, rating, details, comment }
export const createReview = async (req, res) => {
  const body = req.body ?? {};
  const { contract, side } = await loadContract(req, body.contract);
  if (contract.status !== 'completed') throw new AppError('Only completed contracts can be reviewed', 409);

  let reviewee;
  let direction;
  if (side === 'customer') {
    reviewee = contract.pro;
    direction = 'customer_to_pro';
  } else {
    if (!same(contract.pro, req.user._id)) throw AppError.forbidden('Only the main pro can review the customer');
    if (!contract.customer) throw new AppError('This client has no account to review', 400);
    reviewee = contract.customer;
    direction = 'pro_to_customer';
  }

  const review = await Review.create({
    contract: contract._id,
    job: contract.job,
    reviewer: req.user._id,
    reviewee,
    direction,
    rating: body.rating,
    details: body.details,
    comment: body.comment,
  });

  await notify(reviewee, 'new_review', `Ny vurdering: ${'⭐'.repeat(review.rating)}`, contract.title, {
    reviewId: review._id,
  });
  res.status(201).json({ review });
};

// GET /reviews/user/:userId?direction=customer_to_pro   (public)
export const listUserReviews = async (req, res) => {
  const direction = req.query.direction === 'pro_to_customer' ? 'pro_to_customer' : 'customer_to_pro';
  const filter = { reviewee: req.params.userId, direction, visible: true };

  res.json(
    await paginate(Review, filter, getPagination(req.query), {
      populate: { path: 'reviewer', select: 'name avatarUrl' },
    })
  );
};

// POST /reviews/:reviewId/reply  { text }  (the reviewed person answers once)
export const replyToReview = async (req, res) => {
  const review = await Review.findById(req.params.reviewId);
  if (!review) throw AppError.notFound('Review');
  if (!same(review.reviewee, req.user._id)) throw AppError.forbidden();
  if (review.reply?.text) throw new AppError('You have already replied', 409);
  if (!req.body?.text) throw new AppError('text is required', 400);

  review.reply = { text: req.body.text, createdAt: new Date() };
  await review.save();
  res.json({ review });
};

// POST /reviews/:reviewId/hide  (admin)
export const hideReview = async (req, res) => {
  const review = await Review.findById(req.params.reviewId);
  if (!review) throw AppError.notFound('Review');
  review.visible = false;
  await review.save(); // post-save hook recalculates the pro's rating
  res.json({ review });
};
