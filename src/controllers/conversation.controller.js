// /qup-work-api/src/controllers/conversation.controller.js
import { Conversation, Message, User } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { getPagination, paginate } from '../utils/http.js';
import { idOf, loadJob, same } from '../utils/access.js';
import { notify } from '../utils/notify.js';
import { cleanAttachments } from '../utils/uploads.js';

const participantPopulate = { path: 'participants', select: 'name avatarUrl' };

async function loadConversation(req, conversationId) {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation || !conversation.participants.some((p) => same(p, req.user._id))) {
    throw AppError.notFound('Conversation');
  }
  return conversation;
}

async function postMessage(conversation, sender, { text: rawText, attachments }) {
  const text = typeof rawText === 'string' ? rawText.trim() : undefined;
  const files = cleanAttachments(attachments, sender._id);
  const message = await Message.create({
    conversation: conversation._id,
    sender: sender._id,
    text,
    attachments: files,
  });

  const others = conversation.participants.filter((p) => !same(p, sender._id));
  const update = {
    $set: { lastMessage: { text: text || '📎 Vedlegg', sender: sender._id, sentAt: message.createdAt } },
  };
  if (others.length) {
    update.$inc = Object.fromEntries(others.map((p) => [`unreadCounts.${idOf(p)}`, 1]));
  }
  await Conversation.updateOne({ _id: conversation._id }, update);

  for (const p of others) {
    await notify(idOf(p), 'new_message', sender.name, text ? text.slice(0, 120) : 'Sendte et vedlegg', {
      conversationId: conversation._id,
    });
  }
  return message;
}

// GET /conversations
export const listConversations = async (req, res) => {
  const uid = req.user._id.toString();
  const result = await paginate(Conversation, { participants: req.user._id }, getPagination(req.query), {
    sort: { updatedAt: -1 },
    populate: [participantPopulate, { path: 'job', select: 'title status' }],
  });

  result.data = result.data.map((c) => {
    const { unreadCounts, ...rest } = c.toJSON();
    return { ...rest, unread: c.unreadCounts?.get(uid) ?? 0 };
  });
  res.json(result);
};

// GET /conversations/unread → { unread: 5 }  (total over all conversations, for the tab badge)
export const unreadTotal = async (req, res) => {
  const uid = req.user._id.toString();
  const [row] = await Conversation.aggregate([
    { $match: { participants: req.user._id } },
    { $group: { _id: null, unread: { $sum: { $ifNull: [`$unreadCounts.${uid}`, 0] } } } },
  ]);
  res.json({ unread: row?.unread ?? 0 });
};

// POST /conversations  { participant, job, text }
// Returns the existing conversation if there already is one for the same people + job
export const startConversation = async (req, res) => {
  const { participant, job: jobId, text, attachments } = req.body ?? {};
  if (!participant || same(participant, req.user._id)) {
    throw new AppError('participant must be another user', 400);
  }
  if (!(await User.exists({ _id: participant, status: 'active' }))) throw AppError.notFound('User');
  if (jobId) await loadJob(req, jobId, { allowViewer: true }); // must be able to see the job

  let conversation = await Conversation.findOne({
    participants: { $all: [req.user._id, participant], $size: 2 },
    job: jobId ?? null,
  });
  const isNew = !conversation;
  if (isNew) {
    conversation = await Conversation.create({ participants: [req.user._id, participant], job: jobId });
  }

  if (text || attachments?.length) await postMessage(conversation, req.user, { text, attachments });

  await conversation.populate(participantPopulate);
  res.status(isNew ? 201 : 200).json({ conversation });
};

// GET /conversations/:conversationId
export const getConversation = async (req, res) => {
  const conversation = await loadConversation(req, req.params.conversationId);
  await conversation.populate([
    participantPopulate,
    { path: 'job', select: 'title status' },
    { path: 'contract', select: 'title status' },
  ]);
  const { unreadCounts, ...rest } = conversation.toJSON();
  res.json({ conversation: { ...rest, unread: conversation.unreadCounts?.get(req.user._id.toString()) ?? 0 } });
};

// GET /conversations/:conversationId/messages?before=<ISO date>&limit=30
// Newest first. Pass the oldest createdAt you have as "before" to load older messages,
// or the newest createdAt as "after" to fetch only what has arrived since (polling).
export const listMessages = async (req, res) => {
  const conversation = await loadConversation(req, req.params.conversationId);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));

  const filter = { conversation: conversation._id };
  for (const [param, op] of [['before', '$lt'], ['after', '$gt']]) {
    if (!req.query[param]) continue;
    const date = new Date(req.query[param]);
    if (Number.isNaN(date.getTime())) throw new AppError(`${param} must be a valid date`, 400);
    filter.createdAt = { ...filter.createdAt, [op]: date };
  }

  const messages = await Message.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('sender', 'name avatarUrl');
  res.json({ messages, hasMore: messages.length === limit });
};

// POST /conversations/:conversationId/messages  { text, attachments }
export const sendMessage = async (req, res) => {
  const conversation = await loadConversation(req, req.params.conversationId);
  const { text, attachments } = req.body ?? {};
  const message = await postMessage(conversation, req.user, { text, attachments });
  await message.populate('sender', 'name avatarUrl');
  res.status(201).json({ message });
};

// POST /conversations/:conversationId/read
export const markConversationRead = async (req, res) => {
  const conversation = await loadConversation(req, req.params.conversationId);
  const uid = req.user._id;

  await Conversation.updateOne({ _id: conversation._id }, { $set: { [`unreadCounts.${uid}`]: 0 } });
  await Message.updateMany(
    { conversation: conversation._id, sender: { $ne: uid }, 'readBy.user': { $ne: uid } },
    { $push: { readBy: { user: uid, readAt: new Date() } } }
  );
  res.status(204).end();
};
