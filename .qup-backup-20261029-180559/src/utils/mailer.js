// /qup-work-api/src/utils/mailer.js
// Sends email through Resend's HTTP API (no package needed). Set in .env:
//   RESEND_API_KEY=re_...
//   MAIL_FROM="Qup Work <faktura@yourdomain.no>"   (a domain verified in Resend)
// Without RESEND_API_KEY nothing is sent: the email (and attachments) are saved to
// tmp/mail/ instead, so you can open them and check while developing.
//
//   await sendMail({ to, subject, html, text, replyTo, attachments: [{ filename, content: Buffer }] })
//   → { sent: true, id } | { sent: false, saved: 'tmp/mail/...' } | throws on a real failure
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, mailReady } from '../config/env.js';
import { AppError } from './AppError.js';

const MAIL_DIR = fileURLToPath(new URL('../../tmp/mail/', import.meta.url));

export async function sendMail({ to, subject, html, text, replyTo, attachments = [] }) {
  if (!mailReady()) return saveLocally({ to, subject, html, text, attachments });

  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.mail.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.mail.from,
        to: [to],
        subject,
        html,
        text,
        ...(replyTo ? { reply_to: replyTo } : {}),
        attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })),
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new AppError('The email service could not be reached', 502);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new AppError(`Email failed: ${json?.message ?? res.status}`, 502);
  return { sent: true, id: json?.id };
}

async function saveLocally({ to, subject, html, text, attachments }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(MAIL_DIR, `${stamp}-${String(to).replace(/[^\w.@-]/g, '_')}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'email.html'), `<!-- To: ${to}\n     Subject: ${subject} -->\n${html}`);
  if (text) await fs.writeFile(path.join(dir, 'email.txt'), `To: ${to}\nSubject: ${subject}\n\n${text}`);
  for (const a of attachments) await fs.writeFile(path.join(dir, a.filename), a.content);
  console.log(`✉️  email not sent (no RESEND_API_KEY), saved to ${path.relative(process.cwd(), dir)}`);
  return { sent: false, saved: path.relative(process.cwd(), dir) };
}
