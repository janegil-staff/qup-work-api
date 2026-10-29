#!/usr/bin/env bash
# Qup Work API: push notifications, on-site signatures, job-cancel notices, invoice PDFs + email, job alerts
# Run from anywhere:   bash apply-qup-work-api.sh /path/to/qup-work-api
# (or from inside the project folder with no argument)
#
# Every file it replaces is copied to .qup-backup-<time>/ in the project first,
# so you can undo by copying them back. Running it twice is safe.
set -euo pipefail

ROOT="${1:-$PWD}"
cd "$ROOT"
if ! grep -q '"name": "qup-work-api"' package.json 2>/dev/null; then
  echo "❌ $ROOT doesn't look like qup-work-api (no package.json with that name)." >&2
  echo "   Usage: bash apply-qup-work-api.sh /path/to/qup-work-api" >&2
  exit 1
fi

BACKUP=".qup-backup-$(date +%Y%m%d-%H%M%S)"
CHANGED=0

write_file() {
  local path="$1"
  if [ -f "$path" ]; then
    mkdir -p "$BACKUP/$(dirname "$path")"
    cp "$path" "$BACKUP/$path"
  fi
  mkdir -p "$(dirname "$path")"
  cat > "$path"
  CHANGED=$((CHANGED + 1))
  echo "  ✏️  $path"
}

echo "Updating qup-work-api in $ROOT"

# ---- src/config/env.js
write_file 'src/config/env.js' <<'QUP_EOF_0'
// /qup-work-api/src/config/env.js
// One place to read and validate environment variables.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load .env from the project root, however the server is started (nodemon, npm, debugger).
// On hosting platforms there is no .env file and real environment variables are used instead.
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const required = ['MONGO_URI', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env variable: ${key} (did you create .env?)`);
  }
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGO_URI,
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? '15m',
  refreshTokenTtl: process.env.REFRESH_TOKEN_TTL ?? '30d',

  // Our cut on marketplace jobs paid through the app (percent)
  platformFeePercent: Number(process.env.PLATFORM_FEE_PERCENT ?? 8),

  // Photo uploads. The app uploads straight to Cloudinary with a signature from
  // POST /uploads/signature, so the secret never leaves the server. Optional:
  // without these, uploads answer 503 and everything else works as before.
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME ?? '',
    apiKey: process.env.CLOUDINARY_API_KEY ?? '',
    apiSecret: process.env.CLOUDINARY_API_SECRET ?? '',
    folder: (process.env.CLOUDINARY_FOLDER ?? 'qup-work').replace(/^\/+|\/+$/g, ''),
  },

  // Email (invoices). Optional: without a key, emails are saved to tmp/mail/ instead of sent.
  mail: {
    resendApiKey: process.env.RESEND_API_KEY ?? '',
    from: process.env.MAIL_FROM ?? 'Qup Work <onboarding@resend.dev>',
  },
};

export const cloudinaryReady = () =>
  Boolean(env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret);

export const mailReady = () => Boolean(env.mail.resendApiKey);
QUP_EOF_0

# ---- src/controllers/auth.controller.js
write_file 'src/controllers/auth.controller.js' <<'QUP_EOF_1'
// /qup-work-api/src/controllers/auth.controller.js
import { User, Company, ProProfile } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { pick } from '../utils/http.js';
import { issueTokens, verifyRefreshToken } from '../utils/tokens.js';
import { cleanImageUrl } from '../utils/uploads.js';

// POST /auth/register
export const register = async (req, res) => {
  const data = pick(req.body, ['email', 'password', 'name', 'phone']);
  const user = await User.create(data);
  res.status(201).json({ user, ...issueTokens(user) });
};

// POST /auth/login
export const login = async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) throw new AppError('Email and password are required', 400);

  const user = await User.findOne({ email: String(email).toLowerCase().trim() }).select(
    '+password +tokenVersion'
  );
  if (!user || !(await user.comparePassword(String(password)))) {
    throw AppError.unauthorized('Invalid email or password');
  }
  if (user.status !== 'active') throw AppError.forbidden('This account is not active');

  user.lastLoginAt = new Date();
  await user.save();

  res.json({ user, ...issueTokens(user) });
};

// POST /auth/refresh  { refreshToken }
export const refresh = async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (!refreshToken) throw new AppError('refreshToken is required', 400);

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw AppError.unauthorized('Invalid or expired refresh token');
  }

  const user = await User.findById(payload.sub).select('+tokenVersion');
  if (!user || user.status !== 'active' || user.tokenVersion !== payload.tv) {
    throw AppError.unauthorized('Session is no longer valid, please log in again');
  }
  res.json(issueTokens(user));
};

// POST /auth/logout → logs out ALL devices
// Push tokens go too, so a logged-out phone doesn't keep getting notifications
export const logout = async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 }, $set: { pushTokens: [] } });
  res.status(204).end();
};

// GET /auth/me
export const getMe = async (req, res) => {
  const uid = req.user._id;
  const [companies, proProfile] = await Promise.all([
    Company.find({ 'members.user': uid }).select('name orgNumber logoUrl members'),
    ProProfile.findOne({ user: uid }).populate('categories', 'name slug icon'),
  ]);

  res.json({
    user: req.user,
    companies: companies.map((c) => ({
      _id: c._id,
      name: c.name,
      orgNumber: c.orgNumber,
      logoUrl: c.logoUrl,
      role: c.getMemberRole(uid),
    })),
    proProfile,
  });
};

// PATCH /auth/me
export const updateMe = async (req, res) => {
  const data = pick(req.body, ['name', 'phone', 'avatarUrl', 'address', 'location', 'activeRole']);
  if (data.avatarUrl !== undefined) data.avatarUrl = cleanImageUrl(data.avatarUrl, 'avatarUrl');
  if (data.activeRole === 'pro' && !req.user.roles.includes('pro')) {
    throw new AppError('Create a pro profile or company before switching to pro mode', 400);
  }
  req.user.set(data);
  await req.user.save();
  res.json({ user: req.user });
};

// POST /auth/me/password  { currentPassword, newPassword }
export const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (!currentPassword || !newPassword) {
    throw new AppError('currentPassword and newPassword are required', 400);
  }

  const user = await User.findById(req.user._id).select('+password +tokenVersion');
  if (!(await user.comparePassword(String(currentPassword)))) {
    throw AppError.unauthorized('Current password is wrong');
  }

  user.password = newPassword;
  user.tokenVersion += 1; // logs out other devices
  await user.save();

  res.json(issueTokens(user)); // this device stays logged in
};

// POST /auth/me/push-tokens  { token, platform, locale }
// Called after login and when the language changes (same token → replaced, not duplicated)
export const addPushToken = async (req, res) => {
  const { token, platform, locale } = req.body ?? {};
  if (!token || typeof token !== 'string') throw new AppError('token is required', 400);
  if (!/^Expo(nent)?PushToken\[.+\]$/.test(token)) throw new AppError('token must be an Expo push token', 400);
  if (platform !== undefined && !['ios', 'android', 'web'].includes(platform)) {
    throw new AppError('platform must be ios, android or web', 400);
  }

  await User.updateOne({ _id: req.user._id }, { $pull: { pushTokens: { token } } });
  await User.updateOne(
    { _id: req.user._id },
    {
      $push: {
        pushTokens: {
          $each: [{ token, platform, locale: typeof locale === 'string' ? locale.slice(0, 10) : undefined, createdAt: new Date() }],
          $slice: -10,
        },
      },
    }
  );
  res.status(204).end();
};

// DELETE /auth/me/push-tokens  { token }  (call on logout in the app)
export const removePushToken = async (req, res) => {
  const { token } = req.body ?? {};
  if (!token) throw new AppError('token is required', 400);
  await User.updateOne({ _id: req.user._id }, { $pull: { pushTokens: { token } } });
  res.status(204).end();
};
QUP_EOF_1

# ---- src/controllers/invoice.controller.js
write_file 'src/controllers/invoice.controller.js' <<'QUP_EOF_2'
// /qup-work-api/src/controllers/invoice.controller.js
// Invoices are created as drafts. The invoice number + KID are assigned when it is SENT,
// so issued invoices are numbered without gaps.
import { Invoice, Company, Contract, Client, User, TimeEntry } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { pick, getPagination, paginate, addDays } from '../utils/http.js';
import { assertCompanyRole, getMyCompanyIds, loadContract, same } from '../utils/access.js';
import { notify } from '../utils/notify.js';
import { emailInvoice } from '../utils/invoiceEmail.js';
import { buildInvoicePdf, invoiceFileName, invoiceLang } from '../utils/invoicePdf.js';
import { signFileToken, verifyFileToken } from '../utils/tokens.js';

const LINE_FIELDS = ['description', 'quantity', 'unit', 'unitPrice', 'vatRate'];

// KID with MOD10 (Luhn) check digit, as Norwegian banks expect
function kidFor(number) {
  const base = String(number).padStart(6, '0');
  let sum = 0;
  let double = true;
  for (let i = base.length - 1; i >= 0; i--) {
    let d = Number(base[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return base + ((10 - (sum % 10)) % 10);
}

// Companies that are not VAT registered can't charge VAT
function cleanLines(lines, company) {
  if (!Array.isArray(lines)) return [];
  return lines.map((l) => {
    const line = pick(l, LINE_FIELDS);
    line.vatRate = company.vatRegistered ? line.vatRate ?? 25 : 0;
    return line;
  });
}

// Who gets the invoice: from a client, or from a contract's client/customer
async function resolveRecipient(req, body, companyId) {
  let contract;
  if (body.contract) {
    contract = await Contract.findById(body.contract);
    if (!contract || !same(contract.company, companyId)) {
      throw new AppError('That contract does not belong to this company', 400);
    }
  }

  const clientId = body.client ?? contract?.client;
  let client;
  let customer;
  if (clientId) {
    client = await Client.findById(clientId);
    if (!client || !(same(client.company, companyId) || same(client.owner, req.user._id))) {
      throw new AppError('Client not found in this company', 400);
    }
  } else if (contract?.customer) {
    customer = await User.findById(contract.customer).select('name email address');
  }

  const billTo =
    body.billTo ??
    (client
      ? { name: client.name, orgNumber: client.orgNumber, email: client.email, address: client.address?.toObject() }
      : customer
        ? { name: customer.name, email: customer.email, address: customer.address?.toObject() }
        : null);
  if (!billTo?.name) throw new AppError('Invoice needs a client, a contract or billTo.name', 400);

  return { contract, client, customer, billTo };
}

async function loadInvoice(req, invoiceId, { write = false } = {}) {
  const invoice = await Invoice.findById(invoiceId);
  if (!invoice) throw AppError.notFound('Invoice');

  // The customer can read invoices sent to them
  if (!write && same(invoice.customer, req.user._id) && invoice.status !== 'draft') {
    return { invoice, role: 'customer' };
  }
  await assertCompanyRole(req, invoice.company, ['owner', 'admin']);
  return { invoice, role: 'company' };
}

const requireDraft = (invoice) => {
  if (invoice.status !== 'draft') throw new AppError('Only draft invoices can be changed', 409);
};

// GET /invoices?role=company|customer&company=&client=&contract=&status=
//   status=overdue → sent invoices past their due date (the status itself stays "sent")
export const listInvoices = async (req, res) => {
  let filter;
  const isCustomer = req.query.role === 'customer';
  if (isCustomer) {
    filter = { customer: req.user._id };
  } else {
    let ids = await getMyCompanyIds(req, ['owner', 'admin']);
    if (req.query.company) {
      if (!ids.includes(String(req.query.company))) throw AppError.forbidden();
      ids = [String(req.query.company)];
    }
    filter = { company: { $in: ids } };
    if (req.query.client) filter.client = req.query.client;
  }
  if (req.query.contract) filter.contract = req.query.contract;
  if (req.query.status) {
    const statuses = String(req.query.status).split(',');
    if (statuses.includes('overdue')) {
      const others = statuses.filter((s) => s !== 'overdue');
      const late = { status: { $in: ['sent', 'overdue'] }, dueDate: { $lt: new Date() } };
      filter.$or = [late, ...(others.length ? [{ status: { $in: others } }] : [])];
    } else {
      filter.status = { $in: statuses };
    }
  }

  // Customers never see drafts, whatever status they ask for
  if (isCustomer) filter.$and = [{ status: { $ne: 'draft' } }];

  res.json(
    await paginate(Invoice, filter, getPagination(req.query), {
      sort: { updatedAt: -1 },
      populate: [
        { path: 'client', select: 'name' },
        { path: 'company', select: 'name' },
        { path: 'contract', select: 'title' },
      ],
    })
  );
};

// POST /invoices  { company, client | contract | billTo, lines, issueDate, dueDate, notes }
export const createInvoice = async (req, res) => {
  const body = req.body ?? {};
  const company = await assertCompanyRole(req, body.company, ['owner', 'admin']);
  const { contract, client, customer, billTo } = await resolveRecipient(req, body, company._id);

  const issueDate = body.issueDate ? new Date(body.issueDate) : new Date();
  const invoice = await Invoice.create({
    company: company._id,
    createdBy: req.user._id,
    client: client?._id,
    customer: customer?._id,
    contract: contract?._id,
    billTo,
    lines: cleanLines(body.lines, company),
    issueDate,
    dueDate: body.dueDate ? new Date(body.dueDate) : addDays(issueDate, company.invoiceSettings?.paymentTermsDays ?? 14),
    notes: body.notes,
  });
  res.status(201).json({ invoice });
};

// POST /invoices/from-time  { contract, extraLines: [...] }
// Turns all billable, not-yet-invoiced hours on a contract into an invoice draft.
export const createInvoiceFromTime = async (req, res) => {
  const body = req.body ?? {};
  const { contract, side } = await loadContract(req, body.contract);
  if (side !== 'pro' || !contract.company) {
    throw new AppError('The contract must belong to one of your companies', 400);
  }
  if (!contract.hourlyRate) throw new AppError('This contract has no hourly rate', 400);
  const company = await assertCompanyRole(req, contract.company, ['owner', 'admin']);

  const entries = await TimeEntry.find({
    contract: contract._id,
    running: false,
    billable: true,
    invoice: null,
  });
  if (!entries.length) throw new AppError('No billable, uninvoiced hours on this contract', 409);

  const minutes = entries.reduce((s, e) => s + (e.minutes ?? 0), 0);
  const hours = Math.round((minutes / 60) * 100) / 100;
  const vatRate = company.vatRegistered ? contract.vatRate : 0;
  // Contract rates include VAT; invoice lines are excl. VAT
  const unitPrice = Math.round((contract.hourlyRate * 100) / (100 + vatRate));

  const { client, customer, billTo } = await resolveRecipient(req, { contract: contract._id }, company._id);
  const issueDate = new Date();

  const invoice = await Invoice.create({
    company: company._id,
    createdBy: req.user._id,
    client: client?._id,
    customer: customer?._id,
    contract: contract._id,
    billTo,
    lines: [
      {
        description: `Arbeid: ${contract.title}`,
        quantity: hours,
        unit: 'timer',
        unitPrice,
        vatRate,
        timeEntries: entries.map((e) => e._id),
      },
      ...cleanLines(body.extraLines, company), // materials etc.
    ],
    issueDate,
    dueDate: addDays(issueDate, company.invoiceSettings?.paymentTermsDays ?? 14),
  });

  await TimeEntry.updateMany({ _id: { $in: entries.map((e) => e._id) } }, { invoice: invoice._id });
  res.status(201).json({ invoice, hours });
};

// GET /invoices/:invoiceId
export const getInvoice = async (req, res) => {
  const { invoice, role } = await loadInvoice(req, req.params.invoiceId);
  await invoice.populate([
    { path: 'company', select: 'name orgNumber vatRegistered address email phone logoUrl invoiceSettings.bankAccount invoiceSettings.footerText' },
    { path: 'client', select: 'name' },
    { path: 'contract', select: 'title' },
  ]);
  res.json({ invoice, role });
};

// PATCH /invoices/:invoiceId (drafts only)
export const updateInvoice = async (req, res) => {
  const { invoice } = await loadInvoice(req, req.params.invoiceId, { write: true });
  requireDraft(invoice);

  const data = pick(req.body, ['issueDate', 'dueDate', 'notes', 'billTo']);
  if (req.body?.lines) {
    const company = await Company.findById(invoice.company).select('vatRegistered');
    // Keep the time-entry links on existing lines
    const oldLinks = new Map(invoice.lines.map((l) => [String(l._id), l.timeEntries]));
    data.lines = cleanLines(req.body.lines, company).map((l, i) => {
      const id = req.body.lines[i]?._id;
      return id ? { ...l, _id: id, timeEntries: oldLinks.get(String(id)) ?? [] } : l;
    });
  }
  invoice.set(data);
  await invoice.save();
  res.json({ invoice });
};

// POST /invoices/:invoiceId/send  { lang } → assigns number + KID, then emails the PDF to billTo.email
// Answers { invoice, email: { sent, to, saved?, error? } } so the app can say where it went.
export const sendInvoice = async (req, res) => {
  const { invoice } = await loadInvoice(req, req.params.invoiceId, { write: true });
  requireDraft(invoice);

  const company = await Company.findOneAndUpdate(
    { _id: invoice.company },
    { $inc: { 'invoiceSettings.nextInvoiceNumber': 1 } },
    { new: false, projection: { invoiceSettings: 1, name: 1 } }
  );
  const number = company.invoiceSettings?.nextInvoiceNumber ?? 1;

  invoice.set({ number, kid: kidFor(number), status: 'sent', sentAt: new Date() });
  await invoice.save();

  const fullCompany = await Company.findById(invoice.company);
  const email = await emailInvoice(invoice, fullCompany, { lang: invoiceLang(req.body?.lang) });

  await notify(invoice.customer, 'invoice_received', `Ny faktura #${number}`, invoice.billTo.name, {
    invoiceId: invoice._id,
    contractId: invoice.contract,
    invoiceNumber: number,
    actorName: company.name,
  });
  res.json({ invoice, email });
};

// POST /invoices/:invoiceId/email  { to, lang } → send the PDF (again), e.g. to a new address
export const resendInvoiceEmail = async (req, res) => {
  const { invoice } = await loadInvoice(req, req.params.invoiceId, { write: true });
  if (invoice.status === 'draft') throw new AppError('Send the invoice first, drafts are not emailed', 409);
  const company = await Company.findById(invoice.company);
  const email = await emailInvoice(invoice, company, { to: req.body?.to, lang: invoiceLang(req.body?.lang) });
  if (email.error === 'no_email') throw new AppError('A valid email address is needed', 400);
  res.json({ invoice, email });
};

// POST /invoices/:invoiceId/pdf-link  { lang } → { path } valid for 10 minutes.
// The app opens API_URL + path in the browser, which can't send our login header,
// so the link itself carries a short-lived token for this one invoice.
export const getPdfLink = async (req, res) => {
  const { invoice } = await loadInvoice(req, req.params.invoiceId);
  const token = signFileToken({ kind: 'invoice-pdf', id: String(invoice._id), uid: String(req.user._id) });
  const lang = invoiceLang(req.body?.lang);
  res.json({ path: `/invoices/${invoice._id}/pdf?token=${encodeURIComponent(token)}&lang=${lang}` });
};

// GET /invoices/:invoiceId/pdf?token=  (no login header, the token from pdf-link is the proof)
export const getInvoicePdf = async (req, res) => {
  const claims = verifyFileToken(String(req.query.token ?? ''), 'invoice-pdf');
  if (!claims || claims.id !== req.params.invoiceId) throw AppError.unauthorized('This link has expired, open the invoice again');
  const invoice = await Invoice.findById(req.params.invoiceId);
  if (!invoice) throw AppError.notFound('Invoice');
  const company = await Company.findById(invoice.company);

  const lang = invoiceLang(req.query.lang);
  const pdf = await buildInvoicePdf(invoice, company, { lang });
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${invoiceFileName(invoice, lang)}"`,
    'Cache-Control': 'private, no-store',
  });
  res.send(Buffer.from(pdf));
};

// POST /invoices/:invoiceId/mark-paid  { paidAt }
export const markInvoicePaid = async (req, res) => {
  const { invoice } = await loadInvoice(req, req.params.invoiceId, { write: true });
  if (!['sent', 'overdue'].includes(invoice.status)) {
    throw new AppError('Only sent invoices can be marked as paid', 409);
  }
  invoice.set({ status: 'paid', paidAt: req.body?.paidAt ? new Date(req.body.paidAt) : new Date() });
  await invoice.save();
  res.json({ invoice });
};

// DELETE /invoices/:invoiceId → only drafts (sent invoices need a credit note)
export const deleteInvoice = async (req, res) => {
  const { invoice } = await loadInvoice(req, req.params.invoiceId, { write: true });
  if (invoice.status !== 'draft') {
    throw new AppError('Sent invoices cannot be deleted, they must be credited', 409);
  }
  await TimeEntry.updateMany({ invoice: invoice._id }, { $unset: { invoice: 1 } });
  await invoice.deleteOne();
  res.status(204).end();
};
QUP_EOF_2

# ---- src/controllers/job.controller.js
write_file 'src/controllers/job.controller.js' <<'QUP_EOF_3'
// /qup-work-api/src/controllers/job.controller.js
import { Job, Offer, Category } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { pick, getPagination, paginate, geoFilter, escapeRegex } from '../utils/http.js';
import {
  assertCompanyRole, defaultCompanyId, getMyCompanyIds, isJobOwner, loadClient, loadJob,
} from '../utils/access.js';
import { tryLookupPostcode } from '../utils/geo.js';
import { cleanAttachments } from '../utils/uploads.js';
import { notify } from '../utils/notify.js';
import { alertProsAboutJob } from '../utils/jobAlerts.js';

const JOB_FIELDS = [
  'title', 'description', 'category', 'workType', 'address', 'location', 'images', 'budget', 'timing',
];
const MARKETPLACE_FIELDS = ['visibility', 'invitedPros'];

const jobPopulate = [
  { path: 'category', select: 'name slug icon' },
  { path: 'client', select: 'name phone email address' },
  { path: 'customer', select: 'name avatarUrl' },
  { path: 'pro', select: 'name avatarUrl' },
];

// What everyone sees before a pro is hired: no street address, location rounded to ~1 km,
// only the customer's first name
function publicJobView(job) {
  const out = { ...job };
  if (out.address) out.address = { postalCode: out.address.postalCode, city: out.address.city, municipality: out.address.municipality };
  if (out.location?.coordinates) {
    out.location = {
      ...out.location,
      coordinates: out.location.coordinates.map((n) => Math.round(n * 100) / 100),
    };
  }
  if (out.customer?.name) {
    out.customer = { _id: out.customer._id, name: out.customer.name.split(' ')[0], avatarUrl: out.customer.avatarUrl };
  }
  delete out.invitedPros;
  delete out.client;
  return out;
}

// ?category=<id>,<id> → those categories plus their subcategories
async function categoryFilter(param) {
  const ids = String(param).split(',').filter(Boolean);
  const children = await Category.find({ parent: { $in: ids } }).select('_id').lean();
  return { $in: [...ids, ...children.map((c) => c._id)] };
}

// Only photos uploaded through the app (see utils/uploads.js)
const withUploader = (images, uid) => cleanAttachments(images, uid);

// On-site jobs with a postcode but no map position get one from Kartverket, so they
// show up in "near me" searches. If the lookup fails the job is saved without it.
async function fillPlaceFromPostcode(job) {
  if (job.workType === 'remote' || job.location?.coordinates?.length || !job.address?.postalCode) return;
  const place = await tryLookupPostcode(job.address.postalCode);
  if (!place) return;
  if (place.location) job.location = place.location;
  if (!job.address.city && place.city) job.set('address.city', place.city);
  if (!job.address.municipality && place.municipality) job.set('address.municipality', place.municipality);
}

// POST /jobs
//   with "client" → direct job (pro registers work for their own client)
//   without       → marketplace job (customer asks for offers)
export const createJob = async (req, res) => {
  const uid = req.user._id;
  const body = req.body ?? {};
  const data = pick(body, JOB_FIELDS);
  if (data.images) data.images = withUploader(data.images, uid);

  let job;
  if (body.client) {
    if (!req.user.roles.includes('pro')) throw AppError.forbidden('Only pros can create jobs for clients');
    const client = await loadClient(req, body.client);
    const company = body.company ?? client.company ?? (await defaultCompanyId(req));
    if (company) await assertCompanyRole(req, company);

    job = new Job({
      ...data,
      source: 'direct',
      createdBy: uid,
      client: client._id,
      pro: uid,
      company,
      visibility: 'private',
    });
    // Default to the client's address
    if (!data.address && client.address) job.address = client.address.toObject();
    if (!data.location && client.location) job.location = client.location.toObject();
  } else {
    job = new Job({
      ...data,
      ...pick(body, MARKETPLACE_FIELDS),
      source: 'marketplace',
      createdBy: uid,
      customer: uid,
    });
    if (!body.visibility) job.visibility = 'public';
  }

  await fillPlaceFromPostcode(job);
  await job.save();
  res.status(201).json({ job });
};

// GET /jobs?role=customer|pro&status=open,assigned&client=
export const listMyJobs = async (req, res) => {
  const uid = req.user._id;
  const role = req.query.role ?? req.user.activeRole;

  let filter;
  if (role === 'pro') {
    const ids = await getMyCompanyIds(req);
    filter = { $or: [{ pro: uid }, { company: { $in: ids } }] };
  } else {
    filter = { customer: uid };
  }
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  if (req.query.client) filter.client = req.query.client;

  res.json(
    await paginate(Job, filter, getPagination(req.query), {
      sort: { createdAt: -1 },
      populate: jobPopulate,
    })
  );
};

// GET /jobs/feed?q=&category=&workType=&lng=&lat=&radiusKm=   (public: open marketplace jobs)
// Logged in: also invited jobs, without my own jobs, and with myOfferStatus per job
export const jobFeed = async (req, res) => {
  const uid = req.user?._id;
  const filter = {
    source: 'marketplace',
    status: 'open',
    $or: uid
      ? [{ visibility: 'public' }, { visibility: 'invited', invitedPros: uid }]
      : [{ visibility: 'public' }],
  };
  if (uid) filter.customer = { $ne: uid };
  if (req.query.category) filter.category = await categoryFilter(req.query.category);
  if (req.query.workType) filter.workType = req.query.workType;
  if (req.query.q) filter.title = { $regex: escapeRegex(String(req.query.q)), $options: 'i' };
  Object.assign(filter, geoFilter(req.query, 'location') ?? {});

  const result = await paginate(Job, filter, getPagination(req.query), {
    sort: { publishedAt: -1 },
    populate: [
      { path: 'category', select: 'name slug icon' },
      { path: 'customer', select: 'name avatarUrl' },
    ],
  });

  // Tell the app which jobs I've already sent an offer on
  const myOffers = uid
    ? await Offer.find({ job: { $in: result.data.map((j) => j._id) }, pro: uid })
        .select('job status')
        .lean()
    : [];
  const offerByJob = new Map(myOffers.map((o) => [String(o.job), o.status]));

  result.data = result.data.map((j) => ({
    ...publicJobView(j.toJSON()),
    myOfferStatus: offerByJob.get(String(j._id)) ?? null,
  }));
  res.json(result);
};

// GET /jobs/:jobId   (public for open marketplace jobs)
// side: 'guest' | 'viewer' (logged in, not involved) | 'customer' | 'pro'
export const getJob = async (req, res) => {
  if (!req.user) {
    const job = await Job.findOne({
      _id: req.params.jobId,
      source: 'marketplace',
      status: 'open',
      visibility: 'public',
    }).populate(jobPopulate);
    if (!job) throw AppError.notFound('Job');
    return res.json({ job: publicJobView(job.toJSON()), side: 'guest', myOfferStatus: null, myOffer: null });
  }

  const { job, side } = await loadJob(req, req.params.jobId, { allowViewer: true });
  await job.populate(jobPopulate);
  const json = job.toJSON();

  const myOffer =
    side === 'viewer' ? await Offer.findOne({ job: job._id, pro: req.user._id }).select('status').lean() : null;

  res.json({
    job: side === 'viewer' ? publicJobView(json) : json,
    side,
    myOfferStatus: myOffer?.status ?? null,
    myOffer: myOffer ? { _id: myOffer._id, status: myOffer.status } : null,
  });
};

// PATCH /jobs/:jobId
export const updateJob = async (req, res) => {
  const { job, side } = await loadJob(req, req.params.jobId);
  if (!isJobOwner(job, side)) throw AppError.forbidden();
  if (!['draft', 'open'].includes(job.status)) {
    throw new AppError('A job can only be edited while it is a draft or open', 409);
  }

  const data = pick(req.body, JOB_FIELDS);
  if (data.images) data.images = withUploader(data.images, req.user._id);
  job.set(data);
  if (job.source === 'marketplace') job.set(pick(req.body, MARKETPLACE_FIELDS));
  if (data.address?.postalCode && !data.location) job.location = undefined; // moved: look it up again
  await fillPlaceFromPostcode(job);
  await job.save();
  res.json({ job });
};

// POST /jobs/:jobId/publish → marketplace: draft → open
export const publishJob = async (req, res) => {
  const { job, side } = await loadJob(req, req.params.jobId);
  if (job.source !== 'marketplace') throw new AppError('Only marketplace jobs can be published', 400);
  if (!isJobOwner(job, side)) throw AppError.forbidden();
  if (job.status !== 'draft') throw new AppError('Only draft jobs can be published', 409);

  job.status = 'open';
  job.publishedAt = new Date();
  await job.save();
  // Pros nearby in this category hear about it (in the background, so publishing stays fast)
  alertProsAboutJob(job);
  res.json({ job });
};

// POST /jobs/:jobId/cancel
export const cancelJob = async (req, res) => {
  const { job, side } = await loadJob(req, req.params.jobId);
  if (!isJobOwner(job, side)) throw AppError.forbidden();
  if (job.contract) throw new AppError('This job has a contract, cancel the contract instead', 409);
  if (['completed', 'cancelled'].includes(job.status)) {
    throw new AppError(`Job is already ${job.status}`, 409);
  }

  job.status = 'cancelled';
  job.closedAt = new Date();
  await job.save();

  // Pros waiting for an answer hear that the job is gone
  const pending = await Offer.find({ job: job._id, status: 'pending' }).select('pro');
  await Offer.updateMany(
    { _id: { $in: pending.map((o) => o._id) } },
    { status: 'rejected', respondedAt: new Date() }
  );
  for (const o of pending) {
    await notify(o.pro, 'offer_rejected', 'Kunden avlyste oppdraget', `«${job.title}»`, {
      jobId: job._id,
      jobTitle: job.title,
      reason: 'job_cancelled',
    });
  }
  res.json({ job });
};

// DELETE /jobs/:jobId → only drafts
export const deleteJob = async (req, res) => {
  const { job, side } = await loadJob(req, req.params.jobId);
  if (!isJobOwner(job, side)) throw AppError.forbidden();
  if (job.status !== 'draft') throw new AppError('Only draft jobs can be deleted, cancel it instead', 409);
  await job.deleteOne();
  res.status(204).end();
};
QUP_EOF_3

# ---- src/controllers/milestone.controller.js
write_file 'src/controllers/milestone.controller.js' <<'QUP_EOF_4'
// /qup-work-api/src/controllers/milestone.controller.js
// Mounted at /contracts/:contractId/milestones
// Flow: pending → in_progress → submitted → approved
//                                         ↘ changes_requested → submitted ...
import { Milestone, Job } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { pick } from '../utils/http.js';
import { loadContract, requireActiveContract } from '../utils/access.js';
import { notify } from '../utils/notify.js';
import { cleanAttachments, cleanImageUrl } from '../utils/uploads.js';

const MILESTONE_FIELDS = ['title', 'description', 'amount', 'dueDate'];

async function loadMilestone(req) {
  const { contract, side } = await loadContract(req, req.params.contractId);
  const milestone = await Milestone.findOne({ _id: req.params.milestoneId, contract: contract._id });
  if (!milestone) throw AppError.notFound('Milestone');
  return { contract, side, milestone };
}

const requirePro = (side) => {
  if (side !== 'pro') throw AppError.forbidden('Only the pro can do this');
};

const requireStatus = (milestone, allowed) => {
  if (!allowed.includes(milestone.status)) {
    throw new AppError(`Not possible while the milestone is ${milestone.status}`, 409);
  }
};

// Only photos uploaded through the app (see utils/uploads.js)
const withUploader = (attachments, uid) => cleanAttachments(attachments, uid);

// { name, imageUrl, location } drawn on the pro's phone. The image must be one we uploaded.
function cleanSignature(input) {
  if (!input) return null;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < 2) throw new AppError('signature.name is required', 400);
  const imageUrl = cleanImageUrl(input.imageUrl, 'signature.imageUrl');
  if (!imageUrl) throw new AppError('signature.imageUrl is required', 400);
  const signature = { name: name.slice(0, 100), imageUrl, signedAt: new Date() };
  if (input.location?.coordinates) signature.location = input.location;
  return signature;
}

const markJobInProgress = (jobId) =>
  Job.updateOne({ _id: jobId, status: 'assigned' }, { status: 'in_progress' });

// GET /contracts/:contractId/milestones
export const listMilestones = async (req, res) => {
  const { contract } = await loadContract(req, req.params.contractId);
  const milestones = await Milestone.find({ contract: contract._id }).sort({ order: 1 });
  res.json({ milestones });
};

// POST /contracts/:contractId/milestones
export const createMilestone = async (req, res) => {
  const { contract, side } = await loadContract(req, req.params.contractId);
  requirePro(side);
  requireActiveContract(contract);

  const last = await Milestone.findOne({ contract: contract._id }).sort({ order: -1 }).select('order');
  const milestone = await Milestone.create({
    ...pick(req.body, MILESTONE_FIELDS),
    contract: contract._id,
    order: (last?.order ?? 0) + 1,
  });
  res.status(201).json({ milestone });
};

// PATCH /contracts/:contractId/milestones/:milestoneId
export const updateMilestone = async (req, res) => {
  const { contract, side, milestone } = await loadMilestone(req);
  requirePro(side);
  requireActiveContract(contract);
  requireStatus(milestone, ['pending', 'in_progress', 'changes_requested']);

  milestone.set(pick(req.body, MILESTONE_FIELDS));
  await milestone.save();
  res.json({ milestone });
};

// DELETE /contracts/:contractId/milestones/:milestoneId (only pending)
export const deleteMilestone = async (req, res) => {
  const { contract, side, milestone } = await loadMilestone(req);
  requirePro(side);
  requireActiveContract(contract);
  requireStatus(milestone, ['pending']);
  await milestone.deleteOne();
  res.status(204).end();
};

// POST .../:milestoneId/start
export const startMilestone = async (req, res) => {
  const { contract, side, milestone } = await loadMilestone(req);
  requirePro(side);
  requireActiveContract(contract);
  requireStatus(milestone, ['pending', 'changes_requested']);

  milestone.status = 'in_progress';
  await milestone.save();
  await markJobInProgress(contract.job);
  res.json({ milestone });
};

// POST .../:milestoneId/attachments  { attachments: [{ url, kind, tag, ... }] }
// Progress photos while working (doesn't change status)
export const addAttachments = async (req, res) => {
  const { contract, side, milestone } = await loadMilestone(req);
  requirePro(side);
  requireActiveContract(contract);

  const attachments = withUploader(req.body?.attachments, req.user._id);
  if (!attachments.length) throw new AppError('attachments must be a non-empty array', 400);
  milestone.attachments.push(...attachments);
  await milestone.save();
  res.status(201).json({ milestone });
};

// POST .../:milestoneId/submit  { submissionNote, attachments }
export const submitMilestone = async (req, res) => {
  const { contract, side, milestone } = await loadMilestone(req);
  requirePro(side);
  requireActiveContract(contract);
  requireStatus(milestone, ['pending', 'in_progress', 'changes_requested']);

  milestone.attachments.push(...withUploader(req.body?.attachments, req.user._id));
  milestone.set({
    status: 'submitted',
    submissionNote: req.body?.submissionNote,
    submittedAt: new Date(),
  });
  await milestone.save();
  await markJobInProgress(contract.job);

  await notify(contract.customer, 'milestone_submitted', 'Arbeid levert til godkjenning', milestone.title, {
    contractId: contract._id,
    milestoneId: milestone._id,
    jobTitle: contract.title,
    stepTitle: milestone.title,
    actorName: req.user.name,
  });
  res.json({ milestone });
};

// POST .../:milestoneId/approve  { feedback, signature: { name, imageUrl, location } }
//   - the customer approves in their own app, or
//   - the customer signs on the pro's phone on site (signature required)
export const approveMilestone = async (req, res) => {
  const { contract, side, milestone } = await loadMilestone(req);
  requireActiveContract(contract);

  const isCustomer = side === 'customer';
  const signature = cleanSignature(req.body?.signature);
  const isOnSiteSignature = side === 'pro' && signature;
  if (!isCustomer && !isOnSiteSignature) {
    throw AppError.forbidden('The customer must approve, or sign on site');
  }
  // On site the customer can sign off a step the pro never formally started
  requireStatus(milestone, isCustomer ? ['submitted'] : ['pending', 'in_progress', 'submitted', 'changes_requested']);

  milestone.set({
    status: 'approved',
    approvedAt: new Date(),
    approvedBy: req.user._id,
    feedback: req.body?.feedback,
  });
  if (signature) milestone.customerSignature = signature;
  await milestone.save();
  if (isOnSiteSignature) await markJobInProgress(contract.job);
  // TODO (payments step): release escrow payment for this milestone

  if (isCustomer) {
    await notify(contract.pro, 'milestone_approved', 'Arbeid godkjent ✅', milestone.title, {
      contractId: contract._id,
      milestoneId: milestone._id,
      jobTitle: contract.title,
      stepTitle: milestone.title,
      actorName: req.user.name,
    });
  }
  res.json({ milestone });
};

// POST .../:milestoneId/request-changes  { feedback }
export const requestChanges = async (req, res) => {
  const { contract, side, milestone } = await loadMilestone(req);
  if (side !== 'customer') throw AppError.forbidden('Only the customer can request changes');
  requireActiveContract(contract);
  requireStatus(milestone, ['submitted']);
  if (!req.body?.feedback) throw new AppError('feedback is required', 400);

  milestone.set({ status: 'changes_requested', feedback: req.body.feedback });
  await milestone.save();

  await notify(contract.pro, 'changes_requested', 'Kunden ønsker endringer', milestone.title, {
    contractId: contract._id,
    milestoneId: milestone._id,
    jobTitle: contract.title,
    stepTitle: milestone.title,
    actorName: req.user.name,
  });
  res.json({ milestone });
};
QUP_EOF_4

# ---- src/controllers/pro.controller.js
write_file 'src/controllers/pro.controller.js' <<'QUP_EOF_5'
// /qup-work-api/src/controllers/pro.controller.js
import { ProProfile, User, Review, Category } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { pick, setNested, getPagination, paginate, geoFilter, escapeRegex } from '../utils/http.js';
import { assertCompanyRole } from '../utils/access.js';
import { cleanAttachments } from '../utils/uploads.js';

const PROFILE_FIELDS = [
  'headline', 'bio', 'categories', 'skills', 'languages', 'workType',
  'hourlyRate', 'availableForMarketplace', 'notifyNewJobs', 'portfolio', 'certificates', 'company',
];

const profilePopulate = [
  { path: 'categories', select: 'name slug icon' },
  { path: 'company', select: 'name orgNumber logoUrl' },
];

// GET /pros/me
export const getMyProProfile = async (req, res) => {
  const profile = await ProProfile.findOne({ user: req.user._id }).populate(profilePopulate);
  if (!profile) throw AppError.notFound('Pro profile');
  res.json({ profile });
};

// PUT /pros/me → create or update my pro profile
export const upsertMyProProfile = async (req, res) => {
  const uid = req.user._id;
  const data = pick(req.body, PROFILE_FIELDS);
  if (data.company) await assertCompanyRole(req, data.company);

  let profile = await ProProfile.findOne({ user: uid });
  const isNew = !profile;
  if (isNew) profile = new ProProfile({ user: uid });

  // Users can't verify their own certificates; keep the flag for ones that already exist
  if (Array.isArray(data.certificates)) {
    const verified = new Map(profile.certificates.map((c) => [c._id.toString(), c.verified]));
    data.certificates = data.certificates.map((c) => ({
      ...c,
      verified: verified.get(String(c._id)) ?? false,
    }));
  }
  if (data.portfolio !== undefined) data.portfolio = cleanAttachments(data.portfolio, uid);

  profile.set(data);
  setNested(profile, 'serviceArea', req.body?.serviceArea, ['location', 'radiusKm', 'municipalities']);
  await profile.save();

  await User.updateOne({ _id: uid }, { $addToSet: { roles: 'pro' } });
  await profile.populate(profilePopulate);
  res.status(isNew ? 201 : 200).json({ profile });
};

// GET /pros?category=&lng=&lat=&radiusKm=&q=&workType=   (public)
export const searchPros = async (req, res) => {
  const { category, q, workType } = req.query;
  const filter = { availableForMarketplace: true };

  if (category) {
    // the category itself + its subcategories
    const ids = String(category).split(',').filter(Boolean);
    const children = await Category.find({ parent: { $in: ids } }).select('_id').lean();
    filter.categories = { $in: [...ids, ...children.map((c) => c._id)] };
  }
  if (workType) filter.workType = { $in: [workType, 'both'] };
  if (q) {
    // partial match, so "elektr" finds "Elektriker"
    const re = { $regex: escapeRegex(String(q)), $options: 'i' };
    filter.$or = [{ headline: re }, { skills: re }, { bio: re }, { 'serviceArea.municipalities': re }];
  }
  Object.assign(filter, geoFilter(req.query, 'serviceArea.location') ?? {});

  const result = await paginate(ProProfile, filter, getPagination(req.query), {
    sort: { 'stats.ratingAvg': -1, 'stats.ratingCount': -1 },
    populate: [{ path: 'user', select: 'name avatarUrl' }, ...profilePopulate],
    select: '-certificates.number -certificates.fileUrl',
  });
  res.json(result);
};

// GET /pros/:userId   (public)
export const getPro = async (req, res) => {
  const profile = await ProProfile.findOne({ user: req.params.userId })
    .select('-certificates.number -certificates.fileUrl')
    .populate([{ path: 'user', select: 'name avatarUrl createdAt' }, ...profilePopulate]);

  const isMe = Boolean(req.user && profile?.user && req.user._id.equals(profile.user._id));
  if (!profile || (!profile.availableForMarketplace && !isMe)) throw AppError.notFound('Pro');

  const reviews = await Review.find({
    reviewee: req.params.userId,
    direction: 'customer_to_pro',
    visible: true,
  })
    .sort({ createdAt: -1 })
    .limit(5)
    .populate('reviewer', 'name avatarUrl');

  res.json({ profile, reviews });
};
QUP_EOF_5

# ---- src/controllers/upload.controller.js
write_file 'src/controllers/upload.controller.js' <<'QUP_EOF_6'
// /qup-work-api/src/controllers/upload.controller.js
import { createUploadSignature } from '../utils/uploads.js';

// POST /uploads/signature  { purpose: 'milestone' | 'message' | 'avatar' | 'job' | 'signature' }
export const getUploadSignature = async (req, res) => {
  res.json(createUploadSignature(req.user._id.toString(), req.body?.purpose ?? 'milestone'));
};
QUP_EOF_6

# ---- src/models/Invoice.js
write_file 'src/models/Invoice.js' <<'QUP_EOF_7'
// /qup-work-api/src/models/Invoice.js
// Phase 1: the pro invoices their own client. Line prices are EXCLUDING VAT
// (normal for business invoices); totals are calculated automatically.
import mongoose from 'mongoose';
import { addressSchema } from './schemas/common.js';

const { Schema } = mongoose;

const lineSchema = new Schema(
  {
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, enum: ['stk', 'timer', 'm', 'm2', 'km', 'pakke'], default: 'stk' },
    unitPrice: { type: Number, required: true, min: 0 }, // øre excl. VAT
    vatRate: { type: Number, enum: [0, 12, 15, 25], default: 25 },
    amount: Number, // øre excl. VAT (calculated)
    vatAmount: Number, // øre (calculated)
    timeEntries: [{ type: Schema.Types.ObjectId, ref: 'TimeEntry' }], // hours billed on this line
  },
  { _id: true }
);

const invoiceSchema = new Schema(
  {
    company: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Assigned when the invoice is SENT (drafts have no number), so issued invoices
    // are numbered without gaps as Norwegian bookkeeping rules require.
    number: Number,
    kid: String, // KID number for bank payments, generated with the number

    client: { type: Schema.Types.ObjectId, ref: 'Client' },
    customer: { type: Schema.Types.ObjectId, ref: 'User' },
    contract: { type: Schema.Types.ObjectId, ref: 'Contract' },

    // Snapshot of the recipient at the time of invoicing
    billTo: {
      name: { type: String, required: true },
      orgNumber: String,
      email: String,
      address: addressSchema,
    },

    lines: {
      type: [lineSchema],
      validate: { validator: (v) => v.length > 0, message: 'An invoice needs at least one line' },
    },
    subtotal: Number, // øre excl. VAT
    vatTotal: Number, // øre
    total: Number, // øre incl. VAT

    issueDate: { type: Date, default: Date.now },
    dueDate: { type: Date, required: true },

    status: {
      type: String,
      enum: ['draft', 'sent', 'paid', 'overdue', 'cancelled', 'credited'],
      default: 'draft',
    },
    sentAt: Date,
    paidAt: Date,
    notes: { type: String, maxlength: 2000 },
    pdfUrl: String,

    // The PDF emailed to billTo.email (see utils/invoiceEmail.js)
    emailedAt: Date,
    emailedTo: String,
    emailError: String,
  },
  { timestamps: true }
);

invoiceSchema.pre('validate', function () {
  let subtotal = 0;
  let vatTotal = 0;
  for (const line of this.lines ?? []) {
    line.amount = Math.round(line.quantity * line.unitPrice);
    line.vatAmount = Math.round((line.amount * line.vatRate) / 100);
    subtotal += line.amount;
    vatTotal += line.vatAmount;
  }
  this.subtotal = subtotal;
  this.vatTotal = vatTotal;
  this.total = subtotal + vatTotal;

  if (this.dueDate && this.issueDate && this.dueDate < this.issueDate) {
    this.invalidate('dueDate', 'Due date cannot be before issue date');
  }
});

invoiceSchema.index(
  { company: 1, number: 1 },
  { unique: true, partialFilterExpression: { number: { $type: 'number' } } }
);
invoiceSchema.index({ company: 1, status: 1, dueDate: 1 });
invoiceSchema.index({ client: 1, issueDate: -1 });

invoiceSchema.virtual('isOverdue').get(function () {
  return ['sent', 'overdue'].includes(this.status) && this.dueDate < new Date();
});

invoiceSchema.set('toJSON', { virtuals: true, versionKey: false });

export const Invoice = mongoose.model('Invoice', invoiceSchema);
QUP_EOF_7

# ---- src/models/ProProfile.js
write_file 'src/models/ProProfile.js' <<'QUP_EOF_8'
// /qup-work-api/src/models/ProProfile.js
// Public-facing profile for a user with the "pro" role.
import mongoose from 'mongoose';
import { attachmentSchema, pointSchema } from './schemas/common.js';

const { Schema } = mongoose;

const certificateSchema = new Schema(
  {
    name: { type: String, required: true }, // e.g. "Fagbrev elektriker"
    issuer: String,
    number: String,
    expiresAt: Date,
    fileUrl: String,
    verified: { type: Boolean, default: false },
  },
  { _id: true }
);

const proProfileSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    company: { type: Schema.Types.ObjectId, ref: 'Company' },

    headline: { type: String, trim: true, maxlength: 120 }, // "Elektriker i Bergen, 15 års erfaring"
    bio: { type: String, maxlength: 3000 },
    categories: [{ type: Schema.Types.ObjectId, ref: 'Category' }],
    skills: { type: [String], default: [] },
    languages: { type: [String], default: ['no'] },
    workType: { type: String, enum: ['onsite', 'remote', 'both'], default: 'onsite' },

    serviceArea: {
      location: pointSchema, // base location
      radiusKm: { type: Number, default: 30, min: 1, max: 1000 },
      municipalities: { type: [String], default: [] },
    },

    hourlyRate: { type: Number, min: 0 }, // øre, incl. VAT, shown as "fra X kr/t"
    portfolio: { type: [attachmentSchema], default: [] },
    certificates: { type: [certificateSchema], default: [] },

    verification: {
      orgNumberVerified: { type: Boolean, default: false }, // checked against Brønnøysund
      identityVerified: { type: Boolean, default: false }, // BankID later
    },

    // Phase 2: only pros with this on show up in the marketplace
    availableForMarketplace: { type: Boolean, default: false },
    // A notification + push when a matching job is published nearby (see utils/jobAlerts.js)
    notifyNewJobs: { type: Boolean, default: true },

    stats: {
      ratingAvg: { type: Number, default: 0 },
      ratingCount: { type: Number, default: 0 },
      completedJobs: { type: Number, default: 0 },
      responseTimeMinutes: Number,
    },
  },
  { timestamps: true }
);

proProfileSchema.index({ 'serviceArea.location': '2dsphere' });
proProfileSchema.index({ categories: 1, availableForMarketplace: 1 });
proProfileSchema.index({ headline: 'text', bio: 'text', skills: 'text' });

export const ProProfile = mongoose.model('ProProfile', proProfileSchema);
QUP_EOF_8

# ---- src/models/User.js
write_file 'src/models/User.js' <<'QUP_EOF_9'
// /qup-work-api/src/models/User.js
// One account per person. The same user can be a customer, a pro, or both.
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { addressSchema, pointSchema } from './schemas/common.js';

const { Schema } = mongoose;

const pushTokenSchema = new Schema(
  {
    token: { type: String, required: true }, // Expo push token
    platform: { type: String, enum: ['ios', 'android', 'web'] },
    locale: String, // the app language, so the push text matches (e.g. 'nb-NO')
  },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } }
);

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Invalid email'],
    },
    password: { type: String, required: true, minlength: 8, select: false },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    phone: { type: String, trim: true },
    avatarUrl: String,

    roles: {
      type: [{ type: String, enum: ['customer', 'pro', 'admin'] }],
      default: ['customer'],
    },
    activeRole: { type: String, enum: ['customer', 'pro'], default: 'customer' }, // app mode switch

    address: addressSchema,
    location: pointSchema,

    emailVerified: { type: Boolean, default: false },
    phoneVerified: { type: Boolean, default: false },
    pushTokens: { type: [pushTokenSchema], default: [] },

    tokenVersion: { type: Number, default: 0, select: false }, // bump = log out all devices
    status: { type: String, enum: ['active', 'suspended', 'deleted'], default: 'active' },
    lastLoginAt: Date,
  },
  { timestamps: true }
);

userSchema.index({ location: '2dsphere' });

userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.virtual('isPro').get(function () {
  return this.roles?.includes('pro') ?? false;
});

userSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    delete ret.password;
    delete ret.tokenVersion;
    delete ret.pushTokens;
    delete ret.__v;
    return ret;
  },
});

export const User = mongoose.model('User', userSchema);
QUP_EOF_9

# ---- src/routes/invoice.routes.js
write_file 'src/routes/invoice.routes.js' <<'QUP_EOF_10'
// /qup-work-api/src/routes/invoice.routes.js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  listInvoices, createInvoice, createInvoiceFromTime, getInvoice, updateInvoice,
  sendInvoice, markInvoicePaid, deleteInvoice, resendInvoiceEmail, getPdfLink, getInvoicePdf,
} from '../controllers/invoice.controller.js';

const router = Router();
// Opened in a browser: no login header, the short-lived token in the link is checked instead
router.get('/:invoiceId/pdf', getInvoicePdf);

router.use(requireAuth);

router.get('/', listInvoices);
router.post('/', createInvoice);
router.post('/from-time', createInvoiceFromTime); // must come before /:invoiceId

router.get('/:invoiceId', getInvoice);
router.patch('/:invoiceId', updateInvoice);
router.delete('/:invoiceId', deleteInvoice);
router.post('/:invoiceId/send', sendInvoice);
router.post('/:invoiceId/mark-paid', markInvoicePaid);
router.post('/:invoiceId/email', resendInvoiceEmail);
router.post('/:invoiceId/pdf-link', getPdfLink);

export default router;
QUP_EOF_10

# ---- src/utils/invoiceEmail.js
write_file 'src/utils/invoiceEmail.js' <<'QUP_EOF_11'
// /qup-work-api/src/utils/invoiceEmail.js
// Emails an invoice as a PDF to the recipient, and notes on the invoice what happened.
//   const result = await emailInvoice(invoice, company, { to, lang })
//   → { sent, to, saved?, error? }   never throws: the invoice is sent either way
import { buildInvoicePdf, invoiceFileName, invoiceLang } from './invoicePdf.js';
import { sendMail } from './mailer.js';

const EMAIL = /^\S+@\S+\.\S+$/;

const escape = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function money(ore) {
  const abs = Math.abs(Math.round(ore ?? 0));
  const kr = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `kr ${kr},${String(abs % 100).padStart(2, '0')}`;
}
const day = (d) => {
  const x = new Date(d);
  return `${String(x.getDate()).padStart(2, '0')}.${String(x.getMonth() + 1).padStart(2, '0')}.${x.getFullYear()}`;
};
const account = (n) => {
  const d = String(n ?? '').replace(/\D/g, '');
  return d.length === 11 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : n;
};

const COPY = {
  nb: {
    subject: (i, c) => `Faktura ${i.number} fra ${c.name}`,
    hello: (name) => `Hei ${name},`,
    intro: (i, c) => `Her er faktura nr. ${i.number} fra ${c.name}. Fakturaen ligger vedlagt som PDF.`,
    amount: 'Beløp', due: 'Forfall', account: 'Kontonummer', kid: 'KID',
    kidNote: 'Husk å bruke KID-nummeret når du betaler.',
    questions: (c) => `Spørsmål om fakturaen? Svar på denne e-posten, så kommer den fram til ${c.name}.`,
    sentWith: 'Sendt med Qup Work',
  },
  en: {
    subject: (i, c) => `Invoice ${i.number} from ${c.name}`,
    hello: (name) => `Hi ${name},`,
    intro: (i, c) => `Here is invoice no. ${i.number} from ${c.name}. The invoice is attached as a PDF.`,
    amount: 'Amount', due: 'Due date', account: 'Account number', kid: 'KID',
    kidNote: 'Please use the KID number when you pay.',
    questions: (c) => `Questions about the invoice? Reply to this email and it reaches ${c.name}.`,
    sentWith: 'Sent with Qup Work',
  },
};

function compose(invoice, company, lang) {
  const C = COPY[invoiceLang(lang)];
  const bank = company.invoiceSettings?.bankAccount;
  const rows = [
    [C.amount, money(invoice.total)],
    [C.due, day(invoice.dueDate)],
    bank && [C.account, account(bank)],
    invoice.kid && [C.kid, invoice.kid],
  ].filter(Boolean);

  const text = [
    C.hello(invoice.billTo.name),
    '',
    C.intro(invoice, company),
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(invoice.kid ? ['', C.kidNote] : []),
    '',
    C.questions(company),
    '',
    company.name,
    ...[company.email, company.phone].filter(Boolean),
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#ECEEEA;font-family:Helvetica,Arial,sans-serif;color:#1D2A2E">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px" cellpadding="0" cellspacing="0">
<tr><td style="padding:24px 28px;background:#1D2A2E;border-radius:8px 8px 0 0;color:#F3F5F2;font-size:18px;font-weight:bold">${escape(company.name)}</td></tr>
<tr><td style="padding:28px">
<p style="margin:0 0 12px">${escape(C.hello(invoice.billTo.name))}</p>
<p style="margin:0 0 20px;line-height:1.5">${escape(C.intro(invoice, company))}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFF3C4;border-radius:6px">
${rows.map(([k, v]) => `<tr><td style="padding:8px 16px;color:#5B686B;font-size:14px">${escape(k)}</td><td style="padding:8px 16px;font-weight:bold;text-align:right;font-size:15px">${escape(v)}</td></tr>`).join('\n')}
</table>
${invoice.kid ? `<p style="margin:16px 0 0;font-size:14px;color:#5B686B">${escape(C.kidNote)}</p>` : ''}
<p style="margin:24px 0 0;font-size:14px;line-height:1.5;color:#5B686B">${escape(C.questions(company))}</p>
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #D6DBD6;font-size:12px;color:#5B686B">${escape(C.sentWith)}</td></tr>
</table></body></html>`;

  return { subject: C.subject(invoice, company), text, html };
}

export async function emailInvoice(invoice, company, { to, lang = 'nb' } = {}) {
  const address = String(to ?? invoice.billTo?.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(address)) return { sent: false, to: null, error: 'no_email' };

  try {
    const pdf = await buildInvoicePdf(invoice, company, { lang });
    const { subject, text, html } = compose(invoice, company, lang);
    const result = await sendMail({
      to: address,
      subject,
      text,
      html,
      replyTo: company.email || undefined,
      attachments: [{ filename: invoiceFileName(invoice, lang), content: pdf }],
    });
    // Saved locally (no email key) counts as not sent, so the app can say so
    if (result.sent) invoice.set({ emailedAt: new Date(), emailedTo: address, emailError: undefined });
    else invoice.set({ emailError: undefined });
    await invoice.save();
    return { sent: result.sent, to: address, saved: result.saved };
  } catch (err) {
    invoice.set({ emailError: err.message });
    await invoice.save().catch(() => {});
    console.error('invoice email failed:', err.message);
    return { sent: false, to: address, error: err.message };
  }
}
QUP_EOF_11

# ---- src/utils/invoicePdf.js
write_file 'src/utils/invoicePdf.js' <<'QUP_EOF_12'
// /qup-work-api/src/utils/invoicePdf.js
// Builds the invoice as an A4 PDF (pdf-lib, no native parts). Norwegian by default,
// English with lang: 'en'. Drafts get an "UTKAST"/"DRAFT" watermark.
//   const bytes = await buildInvoicePdf(invoice, company, { lang: 'nb' });
// `company` is the full Company document (name, orgNumber, address, invoiceSettings, logoUrl).
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';

const A4 = [595.28, 841.89];
const M = 48; // page margin
const INK = rgb(0.114, 0.165, 0.18); // slate #1D2A2E
const MUTED = rgb(0.357, 0.408, 0.42);
const LINE = rgb(0.84, 0.86, 0.84);
const HIVIS_SOFT = rgb(1, 0.953, 0.769);

const TEXT = {
  nb: {
    invoice: 'FAKTURA', draft: 'UTKAST', number: 'Fakturanr.', date: 'Fakturadato', due: 'Forfallsdato', kid: 'KID',
    to: 'Faktura til', description: 'Beskrivelse', qty: 'Antall', price: 'Pris', vat: 'MVA', amount: 'Beløp',
    subtotal: 'Sum eks. mva', vatLine: (r) => `MVA ${r} %`, total: 'Å betale', notVat: 'Ikke mva-registrert',
    howToPay: 'Betaling', account: 'Kontonummer', orgNr: 'Org.nr.', registry: 'Foretaksregisteret', made: 'Laget med Qup Work',
    page: (n, of) => `Side ${n} av ${of}`, paid: 'BETALT',
    units: { stk: 'stk', timer: 'timer', m: 'm', m2: 'm²', km: 'km', pakke: 'pakke' },
  },
  en: {
    invoice: 'INVOICE', draft: 'DRAFT', number: 'Invoice no.', date: 'Invoice date', due: 'Due date', kid: 'KID',
    to: 'Bill to', description: 'Description', qty: 'Qty', price: 'Price', vat: 'VAT', amount: 'Amount',
    subtotal: 'Subtotal excl. VAT', vatLine: (r) => `VAT ${r} %`, total: 'Amount due', notVat: 'Not VAT registered',
    howToPay: 'Payment', account: 'Account number', orgNr: 'Org. no.', registry: 'Foretaksregisteret', made: 'Made with Qup Work',
    page: (n, of) => `Page ${n} of ${of}`, paid: 'PAID',
    units: { stk: 'pcs', timer: 'hours', m: 'm', m2: 'm²', km: 'km', pakke: 'pack' },
  },
};

export const invoiceLang = (lang) => (lang === 'en' ? 'en' : 'nb');

// 125000 øre → "1 250,00"
function money(ore) {
  const neg = ore < 0;
  const abs = Math.abs(Math.round(ore ?? 0));
  const kr = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${neg ? '-' : ''}${kr},${String(abs % 100).padStart(2, '0')}`;
}

const qty = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100).replace('.', ','));
const day = (d) => {
  if (!d) return '';
  const x = new Date(d);
  return `${String(x.getDate()).padStart(2, '0')}.${String(x.getMonth() + 1).padStart(2, '0')}.${x.getFullYear()}`;
};
const orgNo = (n) => String(n ?? '').replace(/^(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3');
const account = (n) => {
  const d = String(n ?? '').replace(/\D/g, '');
  return d.length === 11 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : n;
};

export function invoiceFileName(invoice, lang = 'nb') {
  const word = invoiceLang(lang) === 'en' ? 'Invoice' : 'Faktura';
  return `${word}-${invoice.number ?? 'utkast'}.pdf`;
}

// Letters that don't simplify by dropping the accent
const SPECIAL = { Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', Ħ: 'H', ħ: 'h', ı: 'i', '✓': 'v' };

// The standard fonts only cover Western European letters (æøå are fine).
// Anything else (ł, ő, Cyrillic, emoji) is swapped for something they can draw.
function safe(font, text) {
  const s = String(text ?? '')
    .normalize('NFC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/−/g, '-')
    .replace(/\s+/g, ' ');
  let out = '';
  for (const ch of s) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      const plain = SPECIAL[ch] ?? ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      try {
        font.encodeText(plain);
        out += plain;
      } catch {
        out += '?';
      }
    }
  }
  return out;
}

// Splits text into lines that fit `width`
function wrap(font, size, text, width) {
  const words = safe(font, text).split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width) line = next;
    else {
      if (line) lines.push(line);
      line = w;
      // a single word longer than the column is cut
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

async function fetchLogo(url) {
  if (!url) return null;
  try {
    // Cloudinary can hand it to us as a small PNG whatever was uploaded
    const src = url.includes('res.cloudinary.com') && url.includes('/upload/')
      ? url.replace('/upload/', '/upload/c_limit,w_360,h_360,f_png/')
      : url;
    const res = await fetch(src, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return { bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get('content-type') ?? '' };
  } catch {
    return null;
  }
}

export async function buildInvoicePdf(invoice, company, { lang = 'nb' } = {}) {
  const L = TEXT[invoiceLang(lang)];
  const doc = await PDFDocument.create();
  doc.setTitle(`${L.invoice} ${invoice.number ?? ''}`.trim());
  doc.setAuthor(company?.name ?? '');
  doc.setCreator('Qup Work');

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const draft = invoice.status === 'draft';
  const vatRegistered = Boolean(company?.vatRegistered);
  const settings = company?.invoiceSettings ?? {};

  const pages = [];
  let page;
  let y;
  const newPage = () => {
    page = doc.addPage(A4);
    pages.push(page);
    y = A4[1] - M;
  };
  const text = (s, x, yy, { f = font, size = 10, color = INK, right = false } = {}) => {
    const str = safe(f, s);
    const w = f.widthOfTextAtSize(str, size);
    page.drawText(str, { x: right ? x - w : x, y: yy, size, font: f, color });
    return w;
  };
  const hr = (yy, color = LINE, thickness = 0.7) =>
    page.drawLine({ start: { x: M, y: yy }, end: { x: A4[0] - M, y: yy }, thickness, color });

  newPage();
  const right = A4[0] - M;

  // ---------- Header: the company on the left, INVOICE + facts on the right
  const logo = await fetchLogo(company?.logoUrl);
  let left = M;
  if (logo) {
    try {
      const img = logo.type.includes('jp') ? await doc.embedJpg(logo.bytes) : await doc.embedPng(logo.bytes);
      const scale = Math.min(56 / img.width, 56 / img.height);
      page.drawImage(img, { x: M, y: y - img.height * scale + 6, width: img.width * scale, height: img.height * scale });
      left = M + img.width * scale + 12;
    } catch {
      // unreadable logo: carry on without it
    }
  }
  text(company?.name ?? '', left, y - 8, { f: bold, size: 15 });
  const fromLines = [
    company?.orgNumber && `${L.orgNr} ${orgNo(company.orgNumber)}${vatRegistered ? ' MVA' : ''}`,
    company?.orgForm === 'AS' && L.registry,
    company?.address?.line1,
    [company?.address?.postalCode, company?.address?.city].filter(Boolean).join(' '),
    company?.email,
    company?.phone,
  ].filter(Boolean);
  let fy = y - 24;
  for (const l of fromLines) {
    text(l, left, fy, { size: 9, color: MUTED });
    fy -= 12;
  }

  text(draft ? `${L.invoice} (${L.draft})` : L.invoice, right, y - 12, { f: bold, size: 22, right: true });
  const facts = [
    invoice.number && [L.number, String(invoice.number)],
    [L.date, day(invoice.issueDate)],
    [L.due, day(invoice.dueDate)],
    invoice.kid && [L.kid, invoice.kid],
  ].filter(Boolean);
  let ry = y - 34;
  for (const [k, v] of facts) {
    text(k, right - 150, ry, { size: 9, color: MUTED });
    text(v, right, ry, { f: bold, size: 9.5, right: true });
    ry -= 14;
  }

  y = Math.min(fy, ry) - 22;

  // ---------- Bill to
  text(L.to.toUpperCase(), M, y, { f: bold, size: 8, color: MUTED });
  y -= 15;
  const b = invoice.billTo ?? {};
  text(b.name ?? '', M, y, { f: bold, size: 11 });
  y -= 13;
  for (const l of [
    b.orgNumber && `${L.orgNr} ${orgNo(b.orgNumber)}`,
    b.address?.line1,
    b.address?.line2,
    [b.address?.postalCode, b.address?.city].filter(Boolean).join(' '),
  ].filter(Boolean)) {
    text(l, M, y, { size: 9.5 });
    y -= 12;
  }
  y -= 18;

  // ---------- Lines
  const cols = vatRegistered
    ? { desc: M, qty: right - 240, price: right - 140, vat: right - 82, amount: right }
    : { desc: M, qty: right - 190, price: right - 90, vat: null, amount: right };
  const descWidth = cols.qty - 60 - cols.desc;
  const header = () => {
    text(L.description, cols.desc, y, { f: bold, size: 8.5, color: MUTED });
    text(L.qty, cols.qty, y, { f: bold, size: 8.5, color: MUTED, right: true });
    text(L.price, cols.price, y, { f: bold, size: 8.5, color: MUTED, right: true });
    if (cols.vat) text(L.vat, cols.vat, y, { f: bold, size: 8.5, color: MUTED, right: true });
    text(L.amount, cols.amount, y, { f: bold, size: 8.5, color: MUTED, right: true });
    y -= 7;
    hr(y, INK, 1);
    y -= 15;
  };
  header();

  for (const line of invoice.lines ?? []) {
    const rows = wrap(font, 9.5, line.description, descWidth);
    const height = rows.length * 12 + 10;
    if (y - height < M + 60) {
      newPage();
      header();
    }
    rows.forEach((r, i) => text(r, cols.desc, y - i * 12, { size: 9.5 }));
    text(`${qty(line.quantity)} ${L.units[line.unit] ?? line.unit ?? ''}`, cols.qty, y, { size: 9.5, right: true });
    text(money(line.unitPrice), cols.price, y, { size: 9.5, right: true });
    if (cols.vat) text(`${line.vatRate ?? 0} %`, cols.vat, y, { size: 9.5, right: true });
    text(money(line.amount), cols.amount, y, { size: 9.5, right: true });
    y -= rows.length * 12 + 4;
    hr(y);
    y -= 14;
  }

  // ---------- Totals (VAT split per rate, as the rules want)
  const byRate = new Map();
  for (const line of invoice.lines ?? []) {
    if (!line.vatAmount) continue;
    byRate.set(line.vatRate, (byRate.get(line.vatRate) ?? 0) + line.vatAmount);
  }
  const totalRows = [[L.subtotal, money(invoice.subtotal)]];
  if (vatRegistered) for (const [rate, amount] of [...byRate].sort((a, c) => c[0] - a[0])) totalRows.push([L.vatLine(rate), money(amount)]);
  else totalRows.push([L.notVat, '']);
  if (y - (totalRows.length * 14 + 120) < M) newPage();

  y -= 4;
  for (const [k, v] of totalRows) {
    text(k, right - 190, y, { size: 9.5, color: MUTED });
    text(v, right, y, { size: 9.5, right: true });
    y -= 14;
  }
  y -= 2;
  page.drawLine({ start: { x: right - 190, y: y + 8 }, end: { x: right, y: y + 8 }, thickness: 1.5, color: INK });
  y -= 8;
  text(L.total, right - 190, y, { f: bold, size: 12 });
  text(`kr ${money(invoice.total)}`, right, y, { f: bold, size: 12, right: true });
  y -= 30;

  // ---------- How to pay
  if (!draft && invoice.status !== 'paid' && (settings.bankAccount || invoice.kid)) {
    const rows = [
      settings.bankAccount && [L.account, account(settings.bankAccount)],
      invoice.kid && [L.kid, invoice.kid],
      [L.amount, `kr ${money(invoice.total)}`],
      [L.due, day(invoice.dueDate)],
    ].filter(Boolean);
    const boxH = rows.length * 15 + 30;
    if (y - boxH < M) newPage();
    page.drawRectangle({ x: M, y: y - boxH + 12, width: A4[0] - 2 * M, height: boxH, color: HIVIS_SOFT });
    text(L.howToPay.toUpperCase(), M + 14, y - 4, { f: bold, size: 8, color: MUTED });
    let py = y - 22;
    for (const [k, v] of rows) {
      text(k, M + 14, py, { size: 10 });
      text(v, M + 150, py, { f: bold, size: 10.5 });
      py -= 15;
    }
    y -= boxH + 10;
  }

  // ---------- Notes and footer text
  for (const block of [invoice.notes, settings.footerText].filter(Boolean)) {
    for (const r of wrap(font, 9, block, A4[0] - 2 * M)) {
      if (y < M + 24) newPage();
      text(r, M, y, { size: 9, color: MUTED });
      y -= 12;
    }
    y -= 8;
  }

  // ---------- On every page: footer, page numbers, and the watermark on drafts / paid
  pages.forEach((p, i) => {
    page = p;
    hr(M - 6);
    text(L.made, M, M - 20, { size: 7.5, color: MUTED });
    if (pages.length > 1) text(L.page(i + 1, pages.length), right, M - 20, { size: 7.5, color: MUTED, right: true });
    const stamp = draft ? L.draft : invoice.status === 'paid' ? L.paid : null;
    if (stamp) {
      p.drawText(stamp, {
        x: 150,
        y: 300,
        size: 96,
        font: bold,
        color: draft ? rgb(0.75, 0.75, 0.75) : rgb(0.18, 0.42, 0.31),
        opacity: 0.18,
        rotate: degrees(35),
      });
    }
  });

  return doc.save();
}
QUP_EOF_12

# ---- src/utils/jobAlerts.js
write_file 'src/utils/jobAlerts.js' <<'QUP_EOF_13'
// /qup-work-api/src/utils/jobAlerts.js
// When a marketplace job is published, tell the pros who could take it:
//   - visible on the marketplace and alerts not turned off (ProProfile.notifyNewJobs)
//   - offer the job's category, its main category or one of its subcategories
//   - on-site jobs: the job is inside their radius, or in a municipality they listed
//   - remote jobs: pros who work remotely, wherever they are
//   - invited jobs: only the invited pros, whatever their area
// Nearest first, at most MAX_PER_JOB pros, and nobody gets more than MAX_PER_HOUR an hour.
// Runs in the background; never throws.
import { Category, Notification, ProProfile } from '../models/index.js';
import { idOf, same } from './access.js';
import { notify } from './notify.js';

const MAX_PER_JOB = 50;
const MAX_PER_HOUR = 5;

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The job's category + its parent + its children, so "Elektriker" and "Elektriker > Lys" both match
async function relatedCategories(categoryId) {
  const cat = await Category.findById(categoryId).select('parent').lean();
  if (!cat) return [];
  const children = await Category.find({ parent: cat._id }).select('_id').lean();
  return [cat._id, cat.parent, ...children.map((c) => c._id)].filter(Boolean);
}

// [{ user, distanceKm? }] nearest first
async function findPros(job, categories) {
  const base = {
    availableForMarketplace: true,
    notifyNewJobs: { $ne: false },
    categories: { $in: categories },
    user: { $ne: idOf(job.customer) },
  };

  if (job.workType === 'remote') {
    const pros = await ProProfile.find({ ...base, workType: { $in: ['remote', 'both'] } })
      .sort({ 'stats.ratingAvg': -1 })
      .limit(MAX_PER_JOB * 2)
      .select('user')
      .lean();
    return pros.map((p) => ({ user: p.user }));
  }

  const onsite = { ...base, workType: { $in: ['onsite', 'both'] } };
  const found = new Map();

  // Inside the pro's own radius (each pro chooses how far they travel)
  const coords = job.location?.coordinates;
  if (coords?.length === 2) {
    const near = await ProProfile.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: coords },
          key: 'serviceArea.location',
          distanceField: 'distance',
          maxDistance: 1000 * 1000, // the largest radius a pro can choose
          query: onsite,
          spherical: true,
        },
      },
      { $match: { $expr: { $lte: ['$distance', { $multiply: [{ $ifNull: ['$serviceArea.radiusKm', 30] }, 1000] }] } } },
      { $limit: MAX_PER_JOB * 2 },
      { $project: { user: 1, distance: 1 } },
    ]);
    for (const p of near) found.set(String(p.user), { user: p.user, distanceKm: Math.round(p.distance / 100) / 10 });
  }

  // Or the municipality / town is on their list
  const places = [job.address?.municipality, job.address?.city].filter(Boolean);
  if (places.length) {
    const byPlace = await ProProfile.find({
      ...onsite,
      'serviceArea.municipalities': { $in: places.map((p) => new RegExp(`^${escapeRegex(p)}$`, 'i')) },
    })
      .limit(MAX_PER_JOB * 2)
      .select('user')
      .lean();
    for (const p of byPlace) if (!found.has(String(p.user))) found.set(String(p.user), { user: p.user });
  }

  // Nearest first; matched only by municipality goes last
  return [...found.values()].sort((a, b) => (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999));
}

// Pros who already got MAX_PER_HOUR job alerts in the last hour are skipped this time
async function withinHourlyLimit(userIds) {
  if (!userIds.length) return [];
  const busy = await Notification.aggregate([
    { $match: { user: { $in: userIds }, type: 'new_job_nearby', createdAt: { $gte: new Date(Date.now() - 3600 * 1000) } } },
    { $group: { _id: '$user', n: { $sum: 1 } } },
    { $match: { n: { $gte: MAX_PER_HOUR } } },
  ]);
  const skip = new Set(busy.map((b) => String(b._id)));
  return userIds.filter((id) => !skip.has(String(id)));
}

export async function alertProsAboutJob(job) {
  try {
    if (job.source !== 'marketplace' || job.status !== 'open') return 0;

    let targets;
    if (job.visibility === 'invited') {
      targets = (job.invitedPros ?? []).filter((p) => !same(p, job.customer)).map((user) => ({ user, invited: true }));
    } else {
      if (!job.category) return 0; // without a category we can't tell who it's for
      const categories = await relatedCategories(idOf(job.category));
      if (!categories.length) return 0;
      targets = await findPros(job, categories);
    }

    const allowed = new Set((await withinHourlyLimit(targets.map((t) => t.user))).map(String));
    const chosen = targets.filter((t) => allowed.has(String(t.user))).slice(0, MAX_PER_JOB);

    const place = job.workType === 'remote' ? null : job.address?.city ?? job.address?.municipality ?? null;
    for (const t of chosen) {
      await notify(t.user, 'new_job_nearby', 'Nytt oppdrag i nærheten', place ? `«${job.title}» i ${place}` : `«${job.title}»`, {
        jobId: job._id,
        jobTitle: job.title,
        place,
        remote: job.workType === 'remote',
        invited: Boolean(t.invited),
        distanceKm: t.distanceKm,
      });
    }
    if (chosen.length) console.log(`📣 job "${job.title}": ${chosen.length} pro(s) notified`);
    return chosen.length;
  } catch (err) {
    console.error('job alerts failed:', err.message);
    return 0;
  }
}
QUP_EOF_13

# ---- src/utils/mailer.js
write_file 'src/utils/mailer.js' <<'QUP_EOF_14'
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
QUP_EOF_14

# ---- src/utils/notify.js
write_file 'src/utils/notify.js' <<'QUP_EOF_15'
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
QUP_EOF_15

# ---- src/utils/push.js
write_file 'src/utils/push.js' <<'QUP_EOF_16'
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
    new_job_nearby: (d) => [
      d.invited ? 'You were invited to a job' : d.remote ? 'New remote job' : 'New job near you',
      d.place ? `“${d.jobTitle}” in ${d.place}` : `“${d.jobTitle}”`,
    ],
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
    new_job_nearby: (d) => [
      d.invited ? 'Du er invitert til et oppdrag' : d.remote ? 'Nytt fjernoppdrag' : 'Nytt oppdrag i nærheten',
      d.place ? `«${d.jobTitle}» i ${d.place}` : `«${d.jobTitle}»`,
    ],
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
QUP_EOF_16

# ---- src/utils/tokens.js
write_file 'src/utils/tokens.js' <<'QUP_EOF_17'
// /qup-work-api/src/utils/tokens.js
// Access token: short-lived, sent on every request (Authorization: Bearer <token>)
// Refresh token: long-lived, only used to get a new access token
// "tv" (token version) lets us log a user out of every device by bumping user.tokenVersion
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

const payloadFor = (user) => ({ sub: user._id.toString(), tv: user.tokenVersion ?? 0 });

export const signAccessToken = (user) =>
  jwt.sign(payloadFor(user), env.jwtAccessSecret, { expiresIn: env.accessTokenTtl });

export const signRefreshToken = (user) =>
  jwt.sign(payloadFor(user), env.jwtRefreshSecret, { expiresIn: env.refreshTokenTtl });

export const verifyAccessToken = (token) => jwt.verify(token, env.jwtAccessSecret);
export const verifyRefreshToken = (token) => jwt.verify(token, env.jwtRefreshSecret);

// Its own secret, so a file link can never pass as a login token
const fileSecret = () => `${env.jwtAccessSecret}:files`;

// Short-lived token for opening one file in a browser (e.g. an invoice PDF)
export const signFileToken = (claims) => jwt.sign({ ...claims, purpose: 'file' }, fileSecret(), { expiresIn: '10m' });
export function verifyFileToken(token, kind) {
  try {
    const claims = jwt.verify(token, fileSecret());
    return claims.purpose === 'file' && claims.kind === kind ? claims : null;
  } catch {
    return null;
  }
}

export const issueTokens = (user) => ({
  accessToken: signAccessToken(user),
  refreshToken: signRefreshToken(user),
});
QUP_EOF_17

# ---- src/utils/uploads.js
write_file 'src/utils/uploads.js' <<'QUP_EOF_18'
// /qup-work-api/src/utils/uploads.js
// Cloudinary signed uploads, and checking attachments before we store them.
//
// How an upload works:
//   1. app → POST /uploads/signature { purpose: 'milestone' }   → { signature, timestamp, folder, ... }
//   2. app → POST https://api.cloudinary.com/v1_1/<cloud>/image/upload with the file + those fields
//   3. app → sends { url, key } from Cloudinary's answer as an attachment (milestone, message)
// The signature only allows uploading into that user's folder, and only for about an hour.
import crypto from 'node:crypto';
import { env, cloudinaryReady } from '../config/env.js';
import { AppError } from './AppError.js';

export const UPLOAD_PURPOSES = ['milestone', 'message', 'avatar', 'job', 'signature'];

// Cloudinary's rule: sort the params, join as a=1&b=2, append the secret, SHA-1 it
export function signParams(params, secret = env.cloudinary.apiSecret) {
  const toSign = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(toSign + secret).digest('hex');
}

export function createUploadSignature(userId, purpose = 'milestone') {
  if (!cloudinaryReady()) {
    throw new AppError('Photo uploads are not set up on the server (missing CLOUDINARY_* in .env)', 503);
  }
  if (!UPLOAD_PURPOSES.includes(purpose)) {
    throw new AppError(`purpose must be one of: ${UPLOAD_PURPOSES.join(', ')}`, 400);
  }
  const { cloudName, apiKey, folder: root } = env.cloudinary;
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `${root}/${purpose}/${userId}`;
  return {
    cloudName,
    apiKey,
    timestamp,
    folder,
    signature: signParams({ folder, timestamp }),
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`,
  };
}

const ATTACHMENT_FIELDS = ['url', 'key', 'kind', 'tag', 'name', 'mimeType', 'size', 'takenAt', 'location'];
const MAX_ATTACHMENTS = 10;

// A single image URL (avatar, logo): must be one of ours. Empty string/null clears it.
export function cleanImageUrl(url, field = 'url') {
  if (url === undefined) return undefined;
  if (url === null || url === '') return null;
  const prefix = cloudinaryReady() ? `https://res.cloudinary.com/${env.cloudinary.cloudName}/` : 'https://';
  if (typeof url !== 'string' || !url.startsWith(prefix)) {
    throw new AppError(`${field} must be uploaded through the app`, 400);
  }
  return url;
}

// Only files we uploaded ourselves: with Cloudinary set up, the URL must be in our cloud.
// (Without it, any https URL is allowed so local testing still works.)
export function cleanAttachments(list, uploadedBy) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new AppError('attachments must be an array', 400);
  if (list.length > MAX_ATTACHMENTS) throw new AppError(`At most ${MAX_ATTACHMENTS} attachments at a time`, 400);

  const prefix = cloudinaryReady() ? `https://res.cloudinary.com/${env.cloudinary.cloudName}/` : 'https://';
  return list.map((a) => {
    const url = typeof a?.url === 'string' ? a.url.trim() : '';
    if (!url.startsWith(prefix)) {
      throw new AppError('Attachments must be uploaded through the app', 400);
    }
    const clean = Object.fromEntries(ATTACHMENT_FIELDS.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
    return { ...clean, url, uploadedBy };
  });
}
QUP_EOF_18

# ---- .gitignore: emails saved locally while developing
if ! grep -qx 'tmp/' .gitignore 2>/dev/null; then
  printf '\n# emails saved locally when RESEND_API_KEY is missing\ntmp/\n' >> .gitignore
  echo "  ✏️  .gitignore"
fi

echo
echo "📦 Installing pdf-lib (for the invoice PDFs)..."
npm install pdf-lib@^1.17.1 || echo "⚠️  Install failed. Run this yourself: npm install pdf-lib"

echo
echo "✅ $CHANGED files updated. Backups of the old ones are in $BACKUP/"
echo "Optional in .env, to really send invoice emails (otherwise they're saved in tmp/mail/):"
echo "  RESEND_API_KEY=re_..."
echo '  MAIL_FROM="Qup Work <faktura@your-domain.no>"' 
echo "Then: npm run dev"
