// /qup-work-api/src/models/Review.js
// Reviews go both ways, but only customer → pro reviews count toward the pro's rating.
import mongoose from 'mongoose';

const { Schema } = mongoose;

const score = { type: Number, min: 1, max: 5 };

const reviewSchema = new Schema(
  {
    contract: { type: Schema.Types.ObjectId, ref: 'Contract', required: true },
    job: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    reviewer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reviewee: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    direction: { type: String, enum: ['customer_to_pro', 'pro_to_customer'], required: true },

    rating: {
      ...score,
      required: true,
      validate: { validator: Number.isInteger, message: 'Rating must be a whole number' },
    },
    details: { quality: score, communication: score, punctuality: score, value: score },
    comment: { type: String, maxlength: 3000 },

    reply: {
      text: { type: String, maxlength: 2000 },
      createdAt: Date,
    },
    visible: { type: Boolean, default: true }, // admins can hide abusive reviews
  },
  { timestamps: true }
);

reviewSchema.index({ contract: 1, reviewer: 1 }, { unique: true }); // one review each per contract
reviewSchema.index({ reviewee: 1, direction: 1, visible: 1, createdAt: -1 });

// Recalculate the pro's average rating
reviewSchema.statics.updateProStats = async function (proUserId) {
  const [stats] = await this.aggregate([
    { $match: { reviewee: proUserId, direction: 'customer_to_pro', visible: true } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);

  await mongoose.model('ProProfile').updateOne(
    { user: proUserId },
    {
      $set: {
        'stats.ratingAvg': stats ? Math.round(stats.avg * 10) / 10 : 0,
        'stats.ratingCount': stats?.count ?? 0,
      },
    }
  );
};

reviewSchema.post('save', async function (doc) {
  if (doc.direction === 'customer_to_pro') {
    await doc.constructor.updateProStats(doc.reviewee);
  }
});

export const Review = mongoose.model('Review', reviewSchema);
