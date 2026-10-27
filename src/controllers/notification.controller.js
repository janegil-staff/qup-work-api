// /qup-work-api/src/controllers/notification.controller.js
import { Notification } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { getPagination, paginate } from '../utils/http.js';

// GET /notifications?unread=true
export const listNotifications = async (req, res) => {
  const filter = { user: req.user._id };
  if (req.query.unread === 'true') filter.readAt = null;
  res.json(await paginate(Notification, filter, getPagination(req.query)));
};

// GET /notifications/unread-count  (for the badge in the app)
export const getUnreadCount = async (req, res) => {
  const count = await Notification.countDocuments({ user: req.user._id, readAt: null });
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

// POST /notifications/read-all
export const markAllNotificationsRead = async (req, res) => {
  const result = await Notification.updateMany(
    { user: req.user._id, readAt: null },
    { $set: { readAt: new Date() } }
  );
  res.json({ updated: result.modifiedCount });
};
