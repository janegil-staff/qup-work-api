// /qup-work-api/src/routes/notification.routes.js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  listNotifications, getUnreadCount, markNotificationRead, markAllNotificationsRead,
} from '../controllers/notification.controller.js';

const router = Router();
router.use(requireAuth);

router.get('/', listNotifications);
router.get('/unread-count', getUnreadCount);
router.post('/read-all', markAllNotificationsRead);
router.post('/:notificationId/read', markNotificationRead);

export default router;
