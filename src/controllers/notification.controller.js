// /qup-work-api/src/controllers/notification.controller.js
import { Notification } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { getPagination, paginate } from '../utils/http.js';

// ?exclude=new_message  → leave those types out (the app's bell skips chat messages,
// which have their own badge on the Messages tab). ?type=new_offer,offer_accepted → only those.
const list = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);
function baseFilter(req) {
  const filter = { user: req.user._id };
  if (req.query.type) filter.type = { $in: list(req.query.type) };
  else if (req.query.exclude) filter.type = { $nin: list(req.query.exclude) };
  return filter;
}

// GET /notifications?unread=true&exclude=new_message
export const listNotifications = async (req, res) => {
  const filter = baseFilter(req);
  if (req.query.unread === 'true') filter.readAt = null;
  res.json(await paginate(Notification, filter, getPagination(req.query)));
};

// GET /notifications/unread-count?exclude=new_message  (for the badge in the app)
export const getUnreadCount = async (req, res) => {
  const count = await Notification.countDocuments({ ...baseFilter(req), readAt: null });
  res.json({ count });
};

// POST /notifications/:notificationId/read
export const markNotificationRead = async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.notificationId, user: req.user._id },
    { $set: { readAt: new Date() } },
    { new: true }
  );
  if (!notification) throw AppError.notFound('Notification');
  res.json({ notification });
};

// POST /notifications/read-all?exclude=new_message
export const markAllNotificationsRead = async (req, res) => {
  const result = await Notification.updateMany(
    { ...baseFilter(req), readAt: null },
    { $set: { readAt: new Date() } }
  );
  res.json({ updated: result.modifiedCount });
};
