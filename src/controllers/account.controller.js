// /qup-work-api/src/controllers/account.controller.js
// Forgot password and delete account (both mounted under /auth).
//
// Forgot password:
//   POST /auth/forgot-password { email, lang }          → always 204 (never says if the email exists)
//   POST /auth/reset-password  { email, code, password } → new password, logged in on this device
// The 6-digit code is emailed, valid for 15 minutes, 5 tries, and stored only as a hash.
//
// Delete account (Apple and Google require it in the app):
//   DELETE /auth/me { password }
// Personal details are wiped and the account can't be used again; the email can sign up anew.
// Contracts, invoices and reviews are kept without the personal details, since the other
// party (and Norwegian bookkeeping rules, 5 years) still need them.
import crypto from 'node:crypto';
import {
  Company, Contract, Conversation, Job, Notification, Offer, ProProfile, User,
} from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { sendMail } from '../utils/mailer.js';
import { notify } from '../utils/notify.js';
import { issueTokens } from '../utils/tokens.js';

const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MIN_PASSWORD = 8;

const hash = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');
const normEmail = (email) => String(email ?? '').toLowerCase().trim();

const RESET_MAIL = {
  nb: {
    subject: (code) => `${code} er koden din for Qup Work`,
    text: (name, code) =>
      `Hei ${name},\n\nKoden for å lage nytt passord i Qup Work er:\n\n${code}\n\nDen gjelder i 15 minutter. Har du ikke bedt om dette, kan du se bort fra e-posten. Passordet ditt er ikke endret.`,
    lead: 'Koden for å lage nytt passord i Qup Work:',
    foot: 'Koden gjelder i 15 minutter. Har du ikke bedt om dette, kan du se bort fra e-posten. Passordet ditt er ikke endret.',
    hello: (name) => `Hei ${name},`,
  },
  en: {
    subject: (code) => `${code} is your Qup Work code`,
    text: (name, code) =>
      `Hi ${name},\n\nYour code for setting a new password in Qup Work is:\n\n${code}\n\nIt's valid for 15 minutes. If you didn't ask for this, you can ignore this email. Your password hasn't changed.`,
    lead: 'Your code for setting a new password in Qup Work:',
    foot: "It's valid for 15 minutes. If you didn't ask for this, you can ignore this email. Your password hasn't changed.",
    hello: (name) => `Hi ${name},`,
  },
};

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function resetMail(user, code, lang) {
  const C = RESET_MAIL[/^(nb|nn|no)\b/i.test(lang ?? '') ? 'nb' : 'en'];
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#ECEEEA;font-family:Helvetica,Arial,sans-serif;color:#1D2A2E">
<table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px" cellpadding="0" cellspacing="0">
<tr><td style="padding:20px 28px;background:#1D2A2E;border-radius:8px 8px 0 0;color:#FFD23F;font-size:18px;font-weight:bold">Qup Work</td></tr>
<tr><td style="padding:28px">
<p style="margin:0 0 12px">${escape(C.hello(user.name))}</p>
<p style="margin:0 0 16px">${escape(C.lead)}</p>
<p style="margin:0 0 20px;font-size:34px;font-weight:bold;letter-spacing:8px;background:#FFF3C4;padding:14px;text-align:center;border-radius:6px">${code}</p>
<p style="margin:0;font-size:14px;color:#5B686B;line-height:1.5">${escape(C.foot)}</p>
</td></tr></table></body></html>`;
  return { subject: C.subject(code), text: C.text(user.name, code), html };
}

// POST /auth/forgot-password { email, lang }
export const forgotPassword = async (req, res) => {
  const email = normEmail(req.body?.email);
  if (!email) throw new AppError('email is required', 400);

  const user = await User.findOne({ email, status: 'active' });
  if (user) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    user.passwordReset = { codeHash: hash(code), expiresAt: new Date(Date.now() + CODE_TTL_MS), attempts: 0 };
    await user.save();
    try {
      await sendMail({ to: email, ...resetMail(user, code, req.body?.lang) });
    } catch (err) {
      console.error('reset email failed:', err.message);
      throw new AppError("The email couldn't be sent right now. Please try again in a minute.", 502);
    }
  }
  // Same answer either way, so nobody can test which emails have an account
  res.status(204).end();
};

// POST /auth/reset-password { email, code, password }
export const resetPassword = async (req, res) => {
  const email = normEmail(req.body?.email);
  const code = String(req.body?.code ?? '').replace(/\D/g, '');
  const password = String(req.body?.password ?? '');
  if (!email || code.length !== 6) throw new AppError('Enter the 6-digit code from the email', 400, { code: 'invalid' });
  if (password.length < MIN_PASSWORD) throw new AppError(`The password must have at least ${MIN_PASSWORD} characters`, 400, { password: 'short' });

  const user = await User.findOne({ email, status: 'active' }).select('+passwordReset +tokenVersion +password');
  const reset = user?.passwordReset;
  const wrong = () => new AppError('The code is wrong or has expired. Ask for a new one.', 400, { code: 'invalid' });
  if (!reset?.codeHash || reset.expiresAt < new Date() || reset.attempts >= MAX_ATTEMPTS) throw wrong();

  if (hash(code) !== reset.codeHash) {
    reset.attempts += 1;
    user.markModified('passwordReset');
    await user.save();
    throw wrong();
  }

  user.password = password;
  user.passwordReset = undefined;
  user.tokenVersion += 1; // other devices are logged out
  user.pushTokens = [];
  user.lastLoginAt = new Date();
  await user.save();
  res.json({ user, ...issueTokens(user) });
};

// DELETE /auth/me { password }
export const deleteAccount = async (req, res) => {
  const uid = req.user._id;
  const user = await User.findById(uid).select('+password +tokenVersion');
  if (!(await user.comparePassword(String(req.body?.password ?? '')))) {
    throw AppError.unauthorized('The password is wrong');
  }

  // Ongoing work has to be finished or cancelled first, so the other side isn't left hanging
  const companies = await Company.find({ 'members.user': uid });
  const active = await Contract.countDocuments({
    status: 'active',
    $or: [{ customer: uid }, { pro: uid }],
  });
  if (active) {
    throw new AppError(`You have ${active} ongoing contract(s). Complete or cancel them first.`, 409, { reason: 'active_contracts' });
  }
  const sharedCompany = companies.find((c) => c.getMemberRole(uid) === 'owner' && c.members.length > 1);
  if (sharedCompany) {
    throw new AppError(`You own ${sharedCompany.name}, which has other members. Remove them first.`, 409, { reason: 'company_members' });
  }

  // Open jobs are taken down, and pros waiting on them are told
  const openJobs = await Job.find({ customer: uid, status: { $in: ['draft', 'open'] } });
  for (const job of openJobs) {
    const pending = await Offer.find({ job: job._id, status: 'pending' }).select('pro');
    await Offer.updateMany({ job: job._id, status: 'pending' }, { status: 'rejected', respondedAt: new Date() });
    for (const o of pending) {
      await notify(o.pro, 'offer_rejected', 'Kunden avlyste oppdraget', `«${job.title}»`, {
        jobId: job._id, jobTitle: job.title, reason: 'job_cancelled',
      });
    }
  }
  await Job.updateMany({ _id: { $in: openJobs.map((j) => j._id) } }, { status: 'cancelled', closedAt: new Date() });

  // My own offers that nobody has answered are withdrawn
  await Offer.updateMany({ pro: uid, status: 'pending' }, { status: 'withdrawn' });

  // Out of every company (a company only I'm in stays, with its invoices, for bookkeeping)
  for (const c of companies) {
    if (c.members.length > 1) {
      c.members = c.members.filter((m) => String(m.user) !== String(uid));
      await c.save();
    }
  }

  await ProProfile.deleteOne({ user: uid });
  await Notification.deleteMany({ user: uid });
  await Conversation.updateMany({ participants: uid }, { $unset: { [`unreadCounts.${uid}`]: 1 } });

  // Wipe what identifies the person; the record stays so old contracts still point somewhere
  user.set({
    email: `deleted-${uid}@deleted.qupwork.invalid`,
    name: 'Slettet bruker',
    password: crypto.randomBytes(24).toString('hex'),
    phone: undefined,
    avatarUrl: undefined,
    address: undefined,
    location: undefined,
    pushTokens: [],
    roles: ['customer'],
    activeRole: 'customer',
    status: 'deleted',
    deletedAt: new Date(),
    passwordReset: undefined,
  });
  user.tokenVersion += 1;
  await user.save();

  res.status(204).end();
};
