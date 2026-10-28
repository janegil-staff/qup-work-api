// /qup-work-api/src/routes/conversation.routes.js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  listConversations, startConversation, getConversation, listMessages, sendMessage,
  markConversationRead, unreadTotal,
} from '../controllers/conversation.controller.js';

const router = Router();
router.use(requireAuth);

router.get('/', listConversations);
router.post('/', startConversation);
router.get('/unread', unreadTotal); // before /:conversationId
router.get('/:conversationId', getConversation);
router.get('/:conversationId/messages', listMessages);
router.post('/:conversationId/messages', sendMessage);
router.post('/:conversationId/read', markConversationRead);

export default router;
