// /qup-work-api/src/routes/auth.routes.js
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import {
  register, login, refresh, logout, getMe, updateMe, changePassword, addPushToken, removePushToken,
} from '../controllers/auth.controller.js';
import { deleteAccount, forgotPassword, resetPassword } from '../controllers/account.controller.js';

const router = Router();

// Slow down password guessing: 20 attempts per 15 min per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts, please try again later' } },
});

router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);
router.post('/refresh', refresh);
router.post('/forgot-password', authLimiter, forgotPassword);
router.post('/reset-password', authLimiter, resetPassword);
router.post('/logout', requireAuth, logout);

router.get('/me', requireAuth, getMe);
router.patch('/me', requireAuth, updateMe);
router.delete('/me', requireAuth, authLimiter, deleteAccount);
router.post('/me/password', requireAuth, changePassword);
router.post('/me/push-tokens', requireAuth, addPushToken);
router.delete('/me/push-tokens', requireAuth, removePushToken);

export default router;
