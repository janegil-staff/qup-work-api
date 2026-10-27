// /qup-work-api/scripts/fix-default-company.js
// Fix: "jobs/clients/offers created without a company"
//
//   1. CODE  → patches 4 files so a pro's only company is used automatically
//   2. DATA  → fills in the missing company on records already in the database
//
// Usage (from the project folder):
//   npm run fix               → patch code + fix data
//   npm run fix -- --dry-run  → show what would change, change nothing
//   npm run fix -- --code-only / --data-only
//
// Safe to run more than once: already-patched files and already-fixed records are skipped.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const DO_CODE = !args.includes('--data-only');
const DO_DATA = !args.includes('--code-only');

// ---------------------------------------------------------------------------
// 1. CODE PATCHES  [file, marker that shows it's already patched, [[find, replace], ...]]
// ---------------------------------------------------------------------------
const PATCHES = [
  [
    'src/utils/access.js',
    'export async function defaultCompanyId',
    [
      [
        '// ---------- Clients ----------',
        `// If I'm in exactly one company, use it when none is given
export async function defaultCompanyId(req) {
  const ids = await getMyCompanyIds(req);
  return ids.length === 1 ? ids[0] : undefined;
}

// ---------- Clients ----------`,
      ],
    ],
  ],
  [
    'src/controllers/client.controller.js',
    'defaultCompanyId',
    [
      [
        "import { assertCompanyRole, getMyCompanyIds, loadClient } from '../utils/access.js';",
        "import { assertCompanyRole, defaultCompanyId, getMyCompanyIds, loadClient } from '../utils/access.js';",
      ],
      [
        `  const data = pick(req.body, CLIENT_FIELDS);
  if (data.company) await assertCompanyRole(req, data.company);
  const client = await Client.create(`,
        `  const data = pick(req.body, CLIENT_FIELDS);
  data.company = data.company ?? (await defaultCompanyId(req));
  if (data.company) await assertCompanyRole(req, data.company);
  const client = await Client.create(`,
      ],
    ],
  ],
  [
    'src/controllers/job.controller.js',
    'defaultCompanyId',
    [
      [
        '  assertCompanyRole, getMyCompanyIds, isJobOwner, loadClient, loadJob,',
        '  assertCompanyRole, defaultCompanyId, getMyCompanyIds, isJobOwner, loadClient, loadJob,',
      ],
      [
        '    const company = body.company ?? client.company;',
        '    const company = body.company ?? client.company ?? (await defaultCompanyId(req));',
      ],
    ],
  ],
  [
    'src/controllers/offer.controller.js',
    'defaultCompanyId',
    [
      [
        "import { assertCompanyRole, isJobOwner, jobSide, loadJob, same } from '../utils/access.js';",
        "import {\n  assertCompanyRole, defaultCompanyId, isJobOwner, jobSide, loadJob, same,\n} from '../utils/access.js';",
      ],
      [
        '  const company = req.body?.company ?? (isDirectQuote ? job.company : undefined);',
        '  const company =\n    req.body?.company ?? (isDirectQuote ? job.company : undefined) ?? (await defaultCompanyId(req));',
      ],
    ],
  ],
];

function patchCode() {
  console.log('\n🔧 Code');
  let failed = false;

  for (const [rel, marker, replacements] of PATCHES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) {
      console.log(`  ❌ ${rel}: file not found`);
      failed = true;
      continue;
    }

    let src = fs.readFileSync(file, 'utf8');
    if (src.includes(marker)) {
      console.log(`  ⏭️  ${rel}: already patched`);
      continue;
    }

    const missing = replacements.filter(([find]) => !src.includes(find));
    if (missing.length) {
      console.log(`  ❌ ${rel}: couldn't find the expected code (was the file edited by hand?)`);
      for (const [find] of missing) console.log(`       looking for: ${find.split('\n')[0].trim()}`);
      failed = true;
      continue;
    }

    for (const [find, replace] of replacements) src = src.replace(find, replace);
    if (!DRY) {
      fs.copyFileSync(file, `${file}.bak`);
      fs.writeFileSync(file, src);
    }
    console.log(`  ✅ ${rel}: ${DRY ? 'would be patched' : 'patched (backup: .bak)'}`);
  }
  return !failed;
}

// ---------------------------------------------------------------------------
// 2. DATA FIX
// ---------------------------------------------------------------------------
async function fixData() {
  console.log(`\n🗄️  Data${DRY ? ' (dry run)' : ''}`);
  if (!process.env.MONGO_URI) {
    console.log('  ❌ MONGO_URI missing. Run via "npm run fix" so .env is loaded.');
    return false;
  }

  const { default: mongoose } = await import('mongoose');
  const { Company, Client, Job, Contract, Offer, TimeEntry } = await import('../src/models/index.js');

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  console.log(`  Connected to ${mongoose.connection.host}/${mongoose.connection.name}`);

  try {
    // userId → companyId, only for users who are in exactly one company
    const rows = await Company.aggregate([
      { $unwind: '$members' },
      { $group: { _id: '$members.user', companies: { $addToSet: '$_id' } } },
      { $match: { companies: { $size: 1 } } },
    ]);
    const companyOf = new Map(rows.map((r) => [String(r._id), r.companies[0]]));
    console.log(`  ${companyOf.size} user(s) belong to exactly one company`);

    const noCompany = { $or: [{ company: { $exists: false } }, { company: null }] };

    // Records owned by one user → that user's only company
    const byUser = async (label, Model, userField, extraFilter = {}) => {
      const docs = await Model.find({ ...noCompany, ...extraFilter }).select(userField).lean();
      const fixable = docs.filter((d) => companyOf.has(String(d[userField])));

      if (!DRY && fixable.length) {
        await Model.bulkWrite(
          fixable.map((d) => ({
            updateOne: {
              filter: { _id: d._id },
              update: { $set: { company: companyOf.get(String(d[userField])) } },
            },
          }))
        );
      }
      const skipped = docs.length - fixable.length;
      console.log(
        `  ${label.padEnd(13)} ${fixable.length} ${DRY ? 'to fix' : 'fixed'}` +
          (skipped ? `, ${skipped} skipped (user has 0 or several companies)` : '')
      );
    };

    await byUser('Clients', Client, 'owner');
    await byUser('Direct jobs', Job, 'pro', { source: 'direct' });
    await byUser('Offers', Offer, 'pro');
    await byUser('Contracts', Contract, 'pro');

    // Time entries take the company from their contract
    const entries = await TimeEntry.find(noCompany).select('contract').lean();
    const contracts = await Contract.find({
      _id: { $in: entries.map((e) => e.contract) },
      company: { $ne: null },
    })
      .select('company')
      .lean();
    const contractCompany = new Map(contracts.map((c) => [String(c._id), c.company]));
    const fixableEntries = entries.filter((e) => contractCompany.has(String(e.contract)));

    if (!DRY && fixableEntries.length) {
      await TimeEntry.bulkWrite(
        fixableEntries.map((e) => ({
          updateOne: {
            filter: { _id: e._id },
            update: { $set: { company: contractCompany.get(String(e.contract)) } },
          },
        }))
      );
    }
    console.log(`  ${'Time entries'.padEnd(13)} ${fixableEntries.length} ${DRY ? 'to fix' : 'fixed'}`);
    // (In a dry run, entries whose contract is fixed in the same run aren't counted yet.)
    return true;
  } finally {
    await mongoose.disconnect();
  }
}

// ---------------------------------------------------------------------------
let ok = true;
if (DO_CODE) ok = patchCode() && ok;
if (DO_DATA) ok = (await fixData()) && ok;

console.log(
  ok
    ? `\n${DRY ? '👀 Dry run done, nothing was changed.' : '🎉 Done. Restart the server if it was not running with --watch.'}\n`
    : '\n⚠️  Finished with problems, see above.\n'
);
process.exit(ok ? 0 : 1);
