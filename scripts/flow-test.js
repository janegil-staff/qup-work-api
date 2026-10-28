// /qup-work-api/scripts/flow-test.js
// Runs the whole app flow against your RUNNING server and reports what passes.
// Creates fresh users on every run, so it doesn't depend on the seed or touch your data.
//
//   npm run test:flow
//   API_URL=https://staging.example.com/api/v1 npm run test:flow
//
// Needs the server running (npm run dev) in another terminal.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const BASE = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4000}/api/v1`;
// Attachments must come from our own Cloudinary when it's set up (see src/utils/uploads.js)
const CLOUD = process.env.CLOUDINARY_CLOUD_NAME;
const photoUrl = (name) =>
  CLOUD ? `https://res.cloudinary.com/${CLOUD}/image/upload/flow-test/${name}` : `https://example.com/${name}`;
// The smallest possible PNG (1×1 pixel), for a real test upload
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const RUN = Date.now().toString(36);

// ---------------------------------------------------------------------------
// Tiny test framework
// ---------------------------------------------------------------------------
const results = { passed: 0, failed: 0, skipped: 0 };
let sectionFailed = false;

class CheckError extends Error {}

// Return SKIPPED from a step when it doesn't apply (e.g. uploads switched off)
const SKIPPED = Symbol('skipped');

function check(condition, message) {
  if (!condition) throw new CheckError(message);
}

async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

// Asserts the status code and returns the body
function expectStatus(res, expected) {
  const ok = Array.isArray(expected) ? expected.includes(res.status) : res.status === expected;
  if (!ok) {
    const msg = res.data?.error?.message ?? JSON.stringify(res.data)?.slice(0, 300);
    const details = res.data?.error?.details ? ` ${JSON.stringify(res.data.error.details)}` : '';
    throw new CheckError(`expected ${expected}, got ${res.status}: ${msg}${details}`);
  }
  return res.data;
}

function section(title) {
  sectionFailed = false;
  console.log(`\n${title}`);
}

async function step(name, fn) {
  if (sectionFailed) {
    results.skipped++;
    console.log(`  ⏭️  ${name}`);
    return undefined;
  }
  try {
    const value = await fn();
    if (value === SKIPPED) {
      results.skipped++;
      console.log(`  ⏭️  ${name} (skipped)`);
      return undefined;
    }
    results.passed++;
    console.log(`  ✅ ${name}`);
    return value;
  } catch (err) {
    results.failed++;
    sectionFailed = true; // later steps in this section depend on this one
    console.log(`  ❌ ${name}\n       ${err instanceof CheckError ? err.message : err.stack}`);
    return undefined;
  }
}

const idOf = (v) => String(v?._id ?? v);

// ---------------------------------------------------------------------------
// Shared state between sections
// ---------------------------------------------------------------------------
const S = {};
const user = (key) => S[key] ?? {};

async function register(key, name) {
  const res = await api(null, 'POST', '/auth/register', {
    email: `flow-${RUN}-${key}@qupwork.test`,
    password: 'Passord123!',
    name,
  });
  if (res.status === 429) {
    throw new CheckError('Rate limited (20 logins/registrations per 15 min). Wait a bit and run again.');
  }
  const data = expectStatus(res, 201);
  S[key] = { token: data.accessToken, refresh: data.refreshToken, id: data.user._id };
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`🧪 Flow test against ${BASE}  (run id: ${RUN})`);

  // ---------------------------------------------------------------- Setup
  section('🔐 Setup');
  await step('server is up and the database is connected', async () => {
    let res;
    try {
      res = await api(null, 'GET', '/health');
    } catch {
      throw new CheckError(`Can't reach ${BASE}. Is the server running (npm run dev)?`);
    }
    const data = expectStatus(res, 200);
    check(data.db === 'connected', `db is ${data.db}`);
  });
  await step('register customer, pro and outsider', async () => {
    await register('customer', 'Test Kunde');
    await register('pro', 'Test Pro');
    await register('outsider', 'Test Utenforstående');
  });
  await step('pro creates a company (becomes pro)', async () => {
    const data = expectStatus(
      await api(user('pro').token, 'POST', '/companies', {
        name: `Flow Elektro ${RUN}`,
        orgForm: 'ENK',
        vatRegistered: true,
        invoiceSettings: { bankAccount: '12345678903' },
      }),
      201
    );
    S.company = data.company._id;
  });
  await step('pro sets up a marketplace profile in Bergen', async () => {
    const cats = expectStatus(await api(null, 'GET', '/categories'), 200).categories;
    S.category = cats.find((c) => c.slug === 'elektriker')?._id ?? cats[0]?._id;
    const data = expectStatus(
      await api(user('pro').token, 'PUT', '/pros/me', {
        headline: 'Flow-test elektriker',
        categories: S.category ? [S.category] : [],
        workType: 'onsite',
        hourlyRate: 95000,
        availableForMarketplace: true,
        serviceArea: { location: { type: 'Point', coordinates: [5.3221, 60.3913] }, radiusKm: 50 },
      }),
      201
    );
    check(idOf(data.profile.company) === S.company || !data.profile.company, 'profile company mismatch');
  });
  await step('/auth/me shows the pro role and the company', async () => {
    const data = expectStatus(await api(user('pro').token, 'GET', '/auth/me'), 200);
    check(data.user.roles.includes('pro'), `roles are ${data.user.roles}`);
    check(data.companies.length === 1 && data.companies[0].role === 'owner', 'company/owner role missing');
  });
  if (sectionFailed) return; // nothing else can work without setup

  // ---------------------------------------------------------------- Uploads
  section('📷 Photo uploads (Cloudinary)');
  await step('server hands out an upload signature (or says uploads are off)', async () => {
    const res = await api(user('pro').token, 'POST', '/uploads/signature', { purpose: 'milestone' });
    if (res.status === 503) {
      S.uploadsOff = true;
      console.log('       ℹ️  The server says photo uploads are off: set CLOUDINARY_* in .env and RESTART the server');
      return SKIPPED;
    }
    const data = expectStatus(res, 200);
    check(data.signature && data.timestamp && data.apiKey && data.cloudName, 'signature fields missing');
    check(data.folder.endsWith(`/milestone/${user('pro').id}`), `folder is ${data.folder}`);
    S.sig = data;
  });
  await step('a test photo uploads to Cloudinary with that signature', async () => {
    if (S.uploadsOff) return SKIPPED;
    const form = new FormData();
    form.append('file', TINY_PNG);
    form.append('api_key', S.sig.apiKey);
    form.append('timestamp', String(S.sig.timestamp));
    form.append('folder', S.sig.folder);
    form.append('signature', S.sig.signature);
    const res = await fetch(S.sig.uploadUrl, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    check(res.ok, `Cloudinary said ${res.status}: ${data.error?.message ?? 'no details'} (check the CLOUDINARY_* values in .env)`);
    check(data.secure_url?.startsWith(`https://res.cloudinary.com/${S.sig.cloudName}/`), 'unexpected URL from Cloudinary');
    S.uploadedUrl = data.secure_url;
    S.uploadedKey = data.public_id;
  });
  await step('an unknown upload purpose is refused (400)', async () => {
    if (S.uploadsOff) return SKIPPED;
    expectStatus(await api(user('pro').token, 'POST', '/uploads/signature', { purpose: 'anything' }), 400);
  });

  // ---------------------------------------------------------------- Direct flow
  section('🔧 Direct flow: pro works for their own client, hourly');
  await step('create client → gets the company automatically', async () => {
    const data = expectStatus(
      await api(user('pro').token, 'POST', '/clients', {
        name: 'Kari Flowtest',
        phone: '91234567',
        address: { line1: 'Storgata 1', postalCode: '5003', city: 'Bergen' },
      }),
      201
    );
    S.client = data.client._id;
    check(idOf(data.client.company) === S.company, 'client.company was not set (run the fix script?)');
  });
  await step('create direct job → copies client address, gets company', async () => {
    const data = expectStatus(
      await api(user('pro').token, 'POST', '/jobs', { client: S.client, title: 'Bytte sikringsskap' }),
      201
    );
    S.directJob = data.job._id;
    check(data.job.source === 'direct', `source is ${data.job.source}`);
    check(data.job.address?.line1 === 'Storgata 1', 'address was not copied from the client');
    check(idOf(data.job.company) === S.company, 'job.company was not set');
  });
  await step('create hourly contract (950 kr/t) → 1 milestone', async () => {
    const data = expectStatus(
      await api(user('pro').token, 'POST', '/contracts', {
        job: S.directJob,
        priceType: 'hourly',
        hourlyRate: 95000,
      }),
      201
    );
    S.directContract = data.contract._id;
    S.directMilestone = data.milestones[0]._id;
    check(data.milestones.length === 1, `${data.milestones.length} milestones`);
    check(data.contract.vatRate === 25, `vatRate is ${data.contract.vatRate}`);
  });
  await step('start timer', async () => {
    const data = expectStatus(
      await api(user('pro').token, 'POST', '/time-entries/start', {
        contract: S.directContract,
        location: { type: 'Point', coordinates: [5.3255, 60.3925] },
      }),
      201
    );
    check(data.entry.running === true, 'entry is not running');
  });
  await step('a second timer is refused (409)', async () => {
    expectStatus(
      await api(user('pro').token, 'POST', '/time-entries/start', { contract: S.directContract }),
      409
    );
  });
  await step('stop timer', async () => {
    const data = expectStatus(await api(user('pro').token, 'POST', '/time-entries/stop', {}), 200);
    check(data.entry.running === false, 'entry still running');
  });
  await step('add 3 hours manually with 30 min break → 150 minutes', async () => {
    const data = expectStatus(
      await api(user('pro').token, 'POST', '/time-entries', {
        contract: S.directContract,
        startedAt: '2026-10-27T08:00:00.000Z',
        endedAt: '2026-10-27T11:00:00.000Z',
        breakMinutes: 30,
        note: 'Demontering av gammelt skap',
      }),
      201
    );
    S.manualEntry = data.entry._id;
    check(data.entry.minutes === 150, `minutes is ${data.entry.minutes}`);
  });
  await step('hours in the future are refused (400)', async () => {
    const start = new Date(Date.now() + 2 * 3600000);
    expectStatus(
      await api(user('pro').token, 'POST', '/time-entries', {
        contract: S.directContract,
        startedAt: start.toISOString(),
        endedAt: new Date(start.getTime() + 3600000).toISOString(),
      }),
      400
    );
  });
  await step('one entry longer than 24 hours is refused (400)', async () => {
    expectStatus(
      await api(user('pro').token, 'POST', '/time-entries', {
        contract: S.directContract,
        startedAt: '2026-10-20T08:00:00.000Z',
        endedAt: '2026-10-21T09:00:00.000Z',
      }),
      400
    );
  });
  await step('contract shows 150 billable minutes', async () => {
    const data = expectStatus(await api(user('pro').token, 'GET', `/contracts/${S.directContract}`), 200);
    check(data.hours.billableMinutes === 150, `billableMinutes is ${data.hours.billableMinutes}`);
    check(data.side === 'pro', `side is ${data.side}`);
  });
  await step('start milestone + add before photo', async () => {
    const base = `/contracts/${S.directContract}/milestones/${S.directMilestone}`;
    expectStatus(await api(user('pro').token, 'POST', `${base}/start`), 200);
    const data = expectStatus(
      await api(user('pro').token, 'POST', `${base}/attachments`, {
        attachments: [{ url: S.uploadedUrl ?? photoUrl('before.jpg'), key: S.uploadedKey, tag: 'before' }],
      }),
      201
    );
    check(data.milestone.attachments.length === 1, 'attachment missing');
  });
  await step('attachments from other websites are refused (400)', async () => {
    if (S.uploadsOff) return SKIPPED; // without Cloudinary any https URL is allowed
    const base = `/contracts/${S.directContract}/milestones/${S.directMilestone}`;
    expectStatus(
      await api(user('pro').token, 'POST', `${base}/attachments`, {
        attachments: [{ url: 'https://evil.example.com/x.jpg', tag: 'before' }],
      }),
      400
    );
  });
  await step('client signs on the pro\'s phone → milestone approved', async () => {
    const data = expectStatus(
      await api(user('pro').token, 'POST', `/contracts/${S.directContract}/milestones/${S.directMilestone}/approve`, {
        signature: { name: 'Kari Flowtest', imageUrl: 'https://example.com/signature.png' },
      }),
      200
    );
    check(data.milestone.status === 'approved', `status is ${data.milestone.status}`);
    check(data.milestone.customerSignature?.name === 'Kari Flowtest', 'signature missing');
  });
  await step('invoice from hours + materials → 4 250,00 kr incl. VAT', async () => {
    // 2.5 h × 760 kr (950 kr excl. 25% VAT) = 1 900 kr + 1 500 kr materials = 3 400 kr + 850 VAT
    const data = expectStatus(
      await api(user('pro').token, 'POST', '/invoices/from-time', {
        contract: S.directContract,
        extraLines: [{ description: 'Sikringsskap og materiell', quantity: 1, unitPrice: 150000 }],
      }),
      201
    );
    S.invoice = data.invoice._id;
    check(data.hours === 2.5, `hours is ${data.hours}`);
    check(data.invoice.subtotal === 340000, `subtotal is ${data.invoice.subtotal}`);
    check(data.invoice.vatTotal === 85000, `vatTotal is ${data.invoice.vatTotal}`);
    check(data.invoice.total === 425000, `total is ${data.invoice.total}`);
    check(data.invoice.billTo?.name === 'Kari Flowtest', 'billTo is not the client');
  });
  await step('the same hours cannot be invoiced twice (409)', async () => {
    expectStatus(
      await api(user('pro').token, 'POST', '/invoices/from-time', { contract: S.directContract }),
      409
    );
  });
  await step('invoiced hours are locked (409)', async () => {
    expectStatus(
      await api(user('pro').token, 'PATCH', `/time-entries/${S.manualEntry}`, { note: 'endret' }),
      409
    );
  });
  await step('send invoice → number 1 and KID 0000018', async () => {
    const data = expectStatus(await api(user('pro').token, 'POST', `/invoices/${S.invoice}/send`), 200);
    check(data.invoice.status === 'sent', `status is ${data.invoice.status}`);
    check(data.invoice.number === 1, `number is ${data.invoice.number}`);
    check(data.invoice.kid === '0000018', `kid is ${data.invoice.kid}`);
  });
  await step('mark invoice paid', async () => {
    const data = expectStatus(await api(user('pro').token, 'POST', `/invoices/${S.invoice}/mark-paid`), 200);
    check(data.invoice.status === 'paid', `status is ${data.invoice.status}`);
  });
  await step('pro completes the contract → job completed', async () => {
    expectStatus(await api(user('pro').token, 'POST', `/contracts/${S.directContract}/complete`), 200);
    const data = expectStatus(await api(user('pro').token, 'GET', `/jobs/${S.directJob}`), 200);
    check(data.job.status === 'completed', `job status is ${data.job.status}`);
  });

  // ---------------------------------------------------------------- Marketplace flow
  section('🏪 Marketplace flow: customer posts a job, pro bids, milestones');
  await step('customer creates a job (draft)', async () => {
    const data = expectStatus(
      await api(user('customer').token, 'POST', '/jobs', {
        title: 'Nytt bad, ca. 6 m²',
        description: 'Rive gammelt bad, nytt rør og fliser.',
        category: S.category,
        address: { line1: 'Hemmelig vei 7', postalCode: '5003', city: 'Bergen' },
        location: { type: 'Point', coordinates: [5.3311, 60.3947] },
        budget: { min: 500000, max: 1000000 },
      }),
      201
    );
    S.marketJob = data.job._id;
    check(data.job.source === 'marketplace' && data.job.status === 'draft', 'wrong source/status');
  });
  await step('draft is not in the pro\'s feed', async () => {
    const data = expectStatus(await api(user('pro').token, 'GET', '/jobs/feed?limit=100'), 200);
    check(!data.data.some((j) => j._id === S.marketJob), 'draft job is visible');
  });
  await step('customer publishes the job', async () => {
    const data = expectStatus(await api(user('customer').token, 'POST', `/jobs/${S.marketJob}/publish`), 200);
    check(data.job.status === 'open', `status is ${data.job.status}`);
  });
  await step('pro finds it in the feed within 50 km, without the street address', async () => {
    const data = expectStatus(
      await api(user('pro').token, 'GET', '/jobs/feed?lng=5.3221&lat=60.3913&radiusKm=50&limit=100'),
      200
    );
    const job = data.data.find((j) => j._id === S.marketJob);
    check(job, 'job not in feed');
    check(!job.address?.line1, 'street address is leaked in the feed');
    check(job.address?.city === 'Bergen', 'city missing');
    check(job.myOfferStatus === null, `myOfferStatus is ${job.myOfferStatus}`);
  });
  await step('job is NOT in the feed when searching around Oslo (100 km)', async () => {
    const data = expectStatus(
      await api(user('pro').token, 'GET', '/jobs/feed?lng=10.7522&lat=59.9139&radiusKm=100&limit=100'),
      200
    );
    check(!data.data.some((j) => j._id === S.marketJob), 'geo filter is not working');
  });
  await step('a guest (not logged in) can browse the feed and open the job', async () => {
    const feed = expectStatus(await api(null, 'GET', '/jobs/feed?limit=100'), 200);
    const listed = feed.data.find((j) => j._id === S.marketJob);
    check(listed, 'job not in the public feed');
    check(!listed.address?.line1, 'street address is leaked to guests');
    check(listed.customer?.name === 'Test', `customer name shown to guests: ${listed.customer?.name}`);

    const detail = expectStatus(await api(null, 'GET', `/jobs/${S.marketJob}`), 200);
    check(detail.side === 'guest', `side is ${detail.side}`);
    check(!detail.job.address?.line1, 'street address is leaked on the detail page');
  });
  await step('guests can\'t open draft or private jobs', async () => {
    expectStatus(await api(null, 'GET', `/jobs/${S.directJob}`), 404);
  });
  await step('pro sends an offer: 8 000 kr in 2 milestones', async () => {
    const data = expectStatus(
      await api(user('pro').token, 'POST', `/jobs/${S.marketJob}/offers`, {
        priceType: 'fixed',
        amount: 800000,
        message: 'Kan starte neste uke.',
        proposedMilestones: [
          { title: 'Rørlegging', amount: 500000 },
          { title: 'Flislegging', amount: 300000 },
        ],
      }),
      201
    );
    S.offer = data.offer._id;
    check(idOf(data.offer.company) === S.company, 'offer.company was not set');
  });
  await step('milestones that don\'t add up are refused (400)', async () => {
    // Uses a separate job so the real one isn't affected; cancelled afterwards
    const job = expectStatus(
      await api(user('customer').token, 'POST', '/jobs', { title: 'Valideringstest' }),
      201
    ).job;
    expectStatus(await api(user('customer').token, 'POST', `/jobs/${job._id}/publish`), 200);
    expectStatus(
      await api(user('pro').token, 'POST', `/jobs/${job._id}/offers`, {
        priceType: 'fixed',
        amount: 100000,
        proposedMilestones: [{ title: 'A', amount: 50000 }],
      }),
      400
    );
    expectStatus(await api(user('customer').token, 'POST', `/jobs/${job._id}/cancel`), 200);
  });
  await step('a second offer on the same job is refused (409)', async () => {
    expectStatus(
      await api(user('pro').token, 'POST', `/jobs/${S.marketJob}/offers`, { priceType: 'fixed', amount: 1 }),
      409
    );
  });
  await step('the job tells the pro which offer is theirs', async () => {
    const data = expectStatus(await api(user('pro').token, 'GET', `/jobs/${S.marketJob}`), 200);
    check(data.myOffer?._id === S.offer && data.myOffer.status === 'pending', 'myOffer missing');
  });
  await step('pro withdraws the offer and sends a new one', async () => {
    const w = expectStatus(await api(user('pro').token, 'POST', `/offers/${S.offer}/withdraw`), 200);
    check(w.offer.status === 'withdrawn', `status is ${w.offer.status}`);
    const data = expectStatus(
      await api(user('pro').token, 'POST', `/jobs/${S.marketJob}/offers`, {
        priceType: 'fixed',
        amount: 800000,
        message: 'Kan starte neste uke.',
        proposedMilestones: [
          { title: 'Rørlegging', amount: 500000 },
          { title: 'Flislegging', amount: 300000 },
        ],
      }),
      201
    );
    check(data.offer.status === 'pending', 'new offer is not pending');
    S.offer = data.offer._id;
  });
  await step('/offers/mine lists the offer with the job and its category', async () => {
    const data = expectStatus(await api(user('pro').token, 'GET', '/offers/mine?status=pending'), 200);
    const mine = data.data.find((o) => o._id === S.offer);
    check(mine?.job?.title === 'Nytt bad, ca. 6 m²', 'job missing on my offer');
    check(!S.category || mine.job.category?.slug, 'category not populated');
  });
  await step('customer sees the offer with the pro\'s profile', async () => {
    const data = expectStatus(await api(user('customer').token, 'GET', `/jobs/${S.marketJob}/offers`), 200);
    check(data.offers.length === 1, `${data.offers.length} offers`);
    check(data.offers[0].proProfile?.headline === 'Flow-test elektriker', 'pro profile missing');
  });
  await step('customer accepts → contract with 2 milestones, escrow, 8% fee', async () => {
    const data = expectStatus(await api(user('customer').token, 'POST', `/offers/${S.offer}/accept`), 201);
    S.marketContract = data.contract._id;
    check(data.contract.paymentMethod === 'escrow', `paymentMethod is ${data.contract.paymentMethod}`);
    check(data.contract.totalAmount === 800000, `totalAmount is ${data.contract.totalAmount}`);
    check(data.offer.status === 'accepted', `offer status is ${data.offer.status}`);

    const ms = expectStatus(
      await api(user('pro').token, 'GET', `/contracts/${S.marketContract}/milestones`),
      200
    ).milestones;
    check(ms.length === 2 && ms[0].amount === 500000 && ms[1].amount === 300000, 'milestones are wrong');
    [S.m1, S.m2] = ms.map((m) => m._id);
  });
  await step('accepting again is refused (409)', async () => {
    expectStatus(await api(user('customer').token, 'POST', `/offers/${S.offer}/accept`), 409);
  });
  await step('pro now sees the full address', async () => {
    const data = expectStatus(await api(user('pro').token, 'GET', `/jobs/${S.marketJob}`), 200);
    check(data.job.address?.line1 === 'Hemmelig vei 7', 'full address missing');
    check(data.job.status === 'assigned', `job status is ${data.job.status}`);
  });
  const ms = (id) => `/contracts/${S.marketContract}/milestones/${id}`;
  await step('pro submits milestone 1 with an after photo', async () => {
    const data = expectStatus(
      await api(user('pro').token, 'POST', `${ms(S.m1)}/submit`, {
        submissionNote: 'Rørene er lagt.',
        attachments: [{ url: photoUrl('after.jpg'), tag: 'after' }],
      }),
      200
    );
    check(data.milestone.status === 'submitted', `status is ${data.milestone.status}`);
  });
  await step('customer requests changes', async () => {
    const data = expectStatus(
      await api(user('customer').token, 'POST', `${ms(S.m1)}/request-changes`, { feedback: 'Mangler sluk.' }),
      200
    );
    check(data.milestone.status === 'changes_requested', `status is ${data.milestone.status}`);
  });
  await step('pro resubmits, customer approves milestone 1', async () => {
    expectStatus(await api(user('pro').token, 'POST', `${ms(S.m1)}/submit`, { submissionNote: 'Sluk montert.' }), 200);
    const data = expectStatus(await api(user('customer').token, 'POST', `${ms(S.m1)}/approve`, {}), 200);
    check(data.milestone.status === 'approved', `status is ${data.milestone.status}`);
  });
  await step('contract can\'t be completed with milestone 2 open (409)', async () => {
    expectStatus(await api(user('customer').token, 'POST', `/contracts/${S.marketContract}/complete`), 409);
  });
  await step('pro can\'t approve their own work without a signature (403)', async () => {
    expectStatus(await api(user('pro').token, 'POST', `${ms(S.m2)}/approve`, {}), 403);
  });
  await step('milestone 2 submitted + approved, customer completes the contract', async () => {
    expectStatus(await api(user('pro').token, 'POST', `${ms(S.m2)}/submit`, {}), 200);
    expectStatus(await api(user('customer').token, 'POST', `${ms(S.m2)}/approve`, {}), 200);
    const data = expectStatus(
      await api(user('customer').token, 'POST', `/contracts/${S.marketContract}/complete`),
      200
    );
    check(data.contract.status === 'completed', `status is ${data.contract.status}`);
  });

  // ---------------------------------------------------------------- Reviews
  section('⭐ Reviews');
  await step('customer reviews the pro (5 stars)', async () => {
    const data = expectStatus(
      await api(user('customer').token, 'POST', '/reviews', {
        contract: S.marketContract,
        rating: 5,
        comment: 'Ryddig og flink!',
      }),
      201
    );
    S.review = data.review._id;
  });
  await step('pro profile shows rating 5.0 and 2 completed jobs', async () => {
    const data = expectStatus(await api(null, 'GET', `/pros/${user('pro').id}`), 200);
    const stats = data.profile.stats;
    check(stats.ratingAvg === 5 && stats.ratingCount === 1, `rating ${stats.ratingAvg} (${stats.ratingCount})`);
    check(stats.completedJobs === 2, `completedJobs is ${stats.completedJobs}`);
    check(data.reviews.length === 1, 'review not listed on the profile');
  });
  await step('pro reviews the customer, then replies to their review', async () => {
    expectStatus(
      await api(user('pro').token, 'POST', '/reviews', { contract: S.marketContract, rating: 5 }),
      201
    );
    const data = expectStatus(
      await api(user('pro').token, 'POST', `/reviews/${S.review}/reply`, { text: 'Takk!' }),
      200
    );
    check(data.review.reply?.text === 'Takk!', 'reply missing');
  });
  await step('reviewing twice is refused (409)', async () => {
    expectStatus(
      await api(user('customer').token, 'POST', '/reviews', { contract: S.marketContract, rating: 1 }),
      409
    );
  });
  await step('the contract shows the customer\'s own review', async () => {
    const data = expectStatus(await api(user('customer').token, 'GET', `/contracts/${S.marketContract}`), 200);
    check(data.myReview?.rating === 5, `myReview is ${JSON.stringify(data.myReview)}`);
  });

  // ---------------------------------------------------------------- Chat
  section('💬 Chat');
  await step('customer starts a conversation about the job', async () => {
    const data = expectStatus(
      await api(user('customer').token, 'POST', '/conversations', {
        participant: user('pro').id,
        job: S.marketJob,
        text: 'Hei! Takk for jobben.',
      }),
      201
    );
    S.conversation = data.conversation._id;
  });
  await step('starting it again returns the same conversation', async () => {
    const data = expectStatus(
      await api(user('customer').token, 'POST', '/conversations', {
        participant: user('pro').id,
        job: S.marketJob,
      }),
      200
    );
    check(data.conversation._id === S.conversation, 'a duplicate conversation was created');
  });
  await step('pro has 1 unread, reads it → 0 unread', async () => {
    const before = expectStatus(await api(user('pro').token, 'GET', '/conversations'), 200);
    const conv = before.data.find((c) => c._id === S.conversation);
    check(conv?.unread === 1, `unread is ${conv?.unread}`);

    const msgs = expectStatus(
      await api(user('pro').token, 'GET', `/conversations/${S.conversation}/messages`),
      200
    );
    check(msgs.messages.length === 1, `${msgs.messages.length} messages`);

    expectStatus(await api(user('pro').token, 'POST', `/conversations/${S.conversation}/read`), 204);
    const after = expectStatus(await api(user('pro').token, 'GET', '/conversations'), 200);
    check(after.data.find((c) => c._id === S.conversation)?.unread === 0, 'still unread');
  });
  await step('pro replies → customer has 1 unread', async () => {
    expectStatus(
      await api(user('pro').token, 'POST', `/conversations/${S.conversation}/messages`, { text: 'Bare hyggelig!' }),
      201
    );
    const data = expectStatus(await api(user('customer').token, 'GET', '/conversations'), 200);
    check(data.data.find((c) => c._id === S.conversation)?.unread === 1, 'customer unread is not 1');
  });
  await step('unread total for the tab badge', async () => {
    const data = expectStatus(await api(user('customer').token, 'GET', '/conversations/unread'), 200);
    check(data.unread >= 1, `unread total is ${data.unread}`);
  });
  await step('polling with ?after= returns only newer messages', async () => {
    const all = expectStatus(
      await api(user('customer').token, 'GET', `/conversations/${S.conversation}/messages`),
      200
    );
    check(all.messages.length === 2, `${all.messages.length} messages`);
    const oldest = all.messages[all.messages.length - 1];
    const newer = expectStatus(
      await api(user('customer').token, 'GET', `/conversations/${S.conversation}/messages?after=${encodeURIComponent(oldest.createdAt)}`),
      200
    );
    check(newer.messages.length === 1 && newer.messages[0].text === 'Bare hyggelig!', 'after= did not filter');
  });
  await step('a blank message is refused', async () => {
    expectStatus(
      await api(user('customer').token, 'POST', `/conversations/${S.conversation}/messages`, { text: '   ' }),
      400
    );
  });
  await step('one conversation shows its unread count', async () => {
    const data = expectStatus(await api(user('customer').token, 'GET', `/conversations/${S.conversation}`), 200);
    check(data.conversation.unread === 1 && !('unreadCounts' in data.conversation), 'unread missing');
  });

  // ---------------------------------------------------------------- Notifications
  section('🔔 Notifications');
  await step('customer and pro both got notifications', async () => {
    const c = expectStatus(await api(user('customer').token, 'GET', '/notifications/unread-count'), 200);
    const p = expectStatus(await api(user('pro').token, 'GET', '/notifications/unread-count'), 200);
    check(c.count > 0, 'customer has no notifications');
    check(p.count > 0, 'pro has no notifications');
  });
  await step('mark all read → 0 unread', async () => {
    expectStatus(await api(user('pro').token, 'POST', '/notifications/read-all'), 200);
    const data = expectStatus(await api(user('pro').token, 'GET', '/notifications/unread-count'), 200);
    check(data.count === 0, `count is ${data.count}`);
  });

  // ---------------------------------------------------------------- Permissions
  section('🛡️  Permissions: an outsider can\'t see or touch anything');
  const denied = [403, 404];
  await step('outsider can\'t see the contract', async () => {
    expectStatus(await api(user('outsider').token, 'GET', `/contracts/${S.directContract}`), denied);
  });
  await step('outsider can\'t see the client register', async () => {
    expectStatus(await api(user('outsider').token, 'GET', `/clients/${S.client}`), denied);
  });
  await step('outsider can\'t see the invoice', async () => {
    expectStatus(await api(user('outsider').token, 'GET', `/invoices/${S.invoice}`), denied);
  });
  await step('outsider can\'t read the conversation', async () => {
    expectStatus(await api(user('outsider').token, 'GET', `/conversations/${S.conversation}/messages`), denied);
  });
  await step('outsider can\'t send an offer (not a pro)', async () => {
    expectStatus(
      await api(user('outsider').token, 'POST', `/jobs/${S.marketJob}/offers`, { priceType: 'fixed', amount: 1 }),
      denied
    );
  });
  await step('customer can read the hours on their contract', async () => {
    const data = expectStatus(
      await api(user('customer').token, 'GET', `/time-entries?contract=${S.marketContract}`),
      200
    );
    check(Array.isArray(data.data) && data.totals, 'hours list or totals missing');
  });
  await step('customer can\'t log hours on the contract', async () => {
    expectStatus(
      await api(user('customer').token, 'POST', '/time-entries/start', { contract: S.marketContract }),
      denied
    );
  });
  await step('no token → 401', async () => {
    expectStatus(await api(null, 'GET', '/jobs'), 401);
  });

  // ---------------------------------------------------------------- Auth
  section('🔑 Auth tokens');
  await step('a refresh token can\'t be used as an access token (401)', async () => {
    const res = await api(user('outsider').refresh, 'GET', '/auth/me');
    if (res.status === 200) {
      throw new CheckError('accepted! Are JWT_ACCESS_SECRET and JWT_REFRESH_SECRET the same in .env?');
    }
    expectStatus(res, 401);
  });
  await step('refresh token gives a new access token', async () => {
    const data = expectStatus(
      await api(null, 'POST', '/auth/refresh', { refreshToken: user('outsider').refresh }),
      200
    );
    check(data.accessToken && data.refreshToken, 'tokens missing');
  });
  await step('logout invalidates existing tokens', async () => {
    expectStatus(await api(user('outsider').token, 'POST', '/auth/logout'), 204);
    expectStatus(await api(user('outsider').token, 'GET', '/auth/me'), 401);
    expectStatus(await api(null, 'POST', '/auth/refresh', { refreshToken: user('outsider').refresh }), 401);
  });
}

// ---------------------------------------------------------------------------
await main();

const { passed, failed, skipped } = results;
console.log(`\n${failed ? '❌' : '🎉'} ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
if (S.customer) console.log(`   Test users: flow-${RUN}-*@qupwork.test (password Passord123!)`);
console.log('');
process.exit(failed ? 1 : 0);