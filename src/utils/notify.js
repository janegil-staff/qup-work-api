// /qup-work-api/src/utils/notify.js
// Creates an in-app notification. Expo push sending gets added here in a later step,
// so every controller that calls notify() automatically gets push too.
import { Notification } from '../models/index.js';

export async function notify(userId, type, title, body, data = {}) {
  if (!userId) return;
  try {
    await Notification.create({ user: userId, type, title, body, data });
    // TODO (push step): look up user.pushTokens and send via Expo
  } catch (err) {
    // A failed notification should never break the actual request
    console.error('notify failed:', err.message);
  }
}
