// /qup-work-api/src/utils/notify.js
// Creates an in-app notification and sends it as a push notification to the user's phones
// (see utils/push.js). Every controller that calls notify() gets both.
//
// title/body are a Norwegian fallback. The app writes its own text in the user's
// language from `type` + `data`, so put what it needs in data:
//   jobTitle, stepTitle, actorName (who did it), plus ids to open the right screen
//   (jobId, contractId, conversationId, ...)
import { Notification } from '../models/index.js';
import { sendPush } from './push.js';

export async function notify(userId, type, title, body, data = {}) {
  if (!userId) return;
  try {
    const notification = await Notification.create({ user: userId, type, title, body, data });
    // The push is sent in the background so the request isn't kept waiting on Expo
    sendPush(userId, notification).then((sent) => {
      if (sent) Notification.updateOne({ _id: notification._id }, { pushedAt: new Date() }).catch(() => {});
    });
  } catch (err) {
    // A failed notification should never break the actual request
    console.error('notify failed:', err.message);
  }
}
