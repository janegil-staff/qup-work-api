// /qup-work-api/src/utils/push.js
// Sends Expo push notifications. Called from notify(), so every in-app notification
// also reaches the phone. Never throws: a failed push must not break the request.
//
// Push text is written here in the language each phone uses (the app sends its locale
// with the token). English and Norwegian for now; other languages get English.
// The app shows its own translated text in the inbox, so this only matters on the lock screen.
import { User } from '../models/index.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const TEXT = {
  en: {
    new_offer: (d) => ['New offer', `${d.actorName} sent an offer on “${d.jobTitle}”`],
    offer_accepted: (d) => ['Your offer was accepted 🎉', `“${d.jobTitle}”: the job is yours.`],
    offer_rejected: (d) => [
      d.reason === 'other_chosen'
        ? 'The job went to someone else'
        : d.reason === 'job_cancelled'
          ? 'The customer cancelled the job'
          : 'Your offer was declined',
      `“${d.jobTitle}”`,
    ],
    milestone_submitted: (d) => ['Work ready for approval', `${d.actorName} marked “${d.stepTitle}” as done on “${d.jobTitle}”`],
    milestone_approved: (d) => ['Work approved ✅', `“${d.stepTitle}” on “${d.jobTitle}”`],
    changes_requested: (d) => ['Changes requested', `“${d.stepTitle}” on “${d.jobTitle}”`],
    contract_completed: (d) => ['Job completed ✅', `“${d.jobTitle}”`],
    contract_cancelled: (d) => ['Job cancelled', `“${d.jobTitle}”`],
    invoice_received: (d) => ['New invoice', `Invoice no. ${d.invoiceNumber} from ${d.actorName}`],
    new_review: (d) => ['New review', `${d.actorName} gave you ${d.rating} of 5 for “${d.jobTitle}”`],
    new_message: (d) => [d.actorName, d.preview ?? 'Attachment'],
  },
  nb: {
    new_offer: (d) => ['Nytt tilbud', `${d.actorName} har sendt et tilbud på «${d.jobTitle}»`],
    offer_accepted: (d) => ['Tilbudet ditt er godtatt 🎉', `«${d.jobTitle}»: oppdraget er ditt.`],
    offer_rejected: (d) => [
      d.reason === 'other_chosen'
        ? 'Oppdraget gikk til en annen'
        : d.reason === 'job_cancelled'
          ? 'Kunden avlyste oppdraget'
          : 'Tilbudet ditt ble avslått',
      `«${d.jobTitle}»`,
    ],
    milestone_submitted: (d) => ['Arbeid klart for godkjenning', `${d.actorName} har markert «${d.stepTitle}» som ferdig på «${d.jobTitle}»`],
    milestone_approved: (d) => ['Arbeid godkjent ✅', `«${d.stepTitle}» på «${d.jobTitle}»`],
    changes_requested: (d) => ['Kunden ønsker endringer', `«${d.stepTitle}» på «${d.jobTitle}»`],
    contract_completed: (d) => ['Oppdraget er fullført ✅', `«${d.jobTitle}»`],
    contract_cancelled: (d) => ['Oppdraget ble avbrutt', `«${d.jobTitle}»`],
    invoice_received: (d) => ['Ny faktura', `Faktura nr. ${d.invoiceNumber} fra ${d.actorName}`],
    new_review: (d) => ['Ny vurdering', `${d.actorName} ga deg ${d.rating} av 5 for «${d.jobTitle}»`],
    new_message: (d) => [d.actorName, d.preview ?? 'Vedlegg'],
  },
};

// 'nb-NO' / 'nn-NO' / 'no' → nb, everything else → en
const langOf = (locale) => (/^(nb|nn|no)\b/i.test(locale ?? '') ? 'nb' : 'en');

function textFor(locale, notification) {
  const builder = TEXT[langOf(locale)][notification.type];
  const data = notification.data ?? {};
  try {
    const built = builder?.(data);
    // A missing detail would show "undefined" on the lock screen; use the stored text instead
    if (built && built.every((s) => s && !String(s).includes('undefined'))) return built;
  } catch {
    // fall through
  }
  return [notification.title, notification.body ?? ''];
}

// Ids are turned into strings so the app can route on them directly
function plainData(notification) {
  const data = Object.fromEntries(
    Object.entries(notification.data ?? {}).map(([k, v]) => [k, v != null && typeof v === 'object' ? String(v) : v])
  );
  return { type: notification.type, notificationId: String(notification._id), ...data };
}

export async function sendPush(userId, notification) {
  try {
    const user = await User.findById(userId).select('pushTokens').lean();
    const tokens = user?.pushTokens ?? [];
    if (!tokens.length) return false;

    const messages = tokens.map(({ token, locale }) => {
      const [title, body] = textFor(locale, notification);
      return {
        to: token,
        title,
        body,
        sound: 'default',
        data: plainData(notification),
        // Chat messages in one conversation replace each other on Android instead of piling up
        ...(notification.type === 'new_message' && notification.data?.conversationId
          ? { channelId: 'default', collapseId: String(notification.data.conversationId) }
          : { channelId: 'default' }),
      };
    });

    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(8000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      console.error('push failed:', res.status, json?.errors?.[0]?.message ?? '');
      return false;
    }

    // Tokens Expo says are dead (app uninstalled, push turned off) are removed
    const dead = (json?.data ?? [])
      .map((ticket, i) => (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered' ? messages[i].to : null))
      .filter(Boolean);
    if (dead.length) {
      await User.updateOne({ _id: userId }, { $pull: { pushTokens: { token: { $in: dead } } } });
    }
    return (json?.data ?? []).some((ticket) => ticket.status === 'ok');
  } catch (err) {
    console.error('push failed:', err.message);
    return false;
  }
}
