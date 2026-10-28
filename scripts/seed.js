// /qup-work-api/scripts/seed.js
// Fills the database with test data you can log in with right away.
//
//   npm run seed            → creates/updates test data (safe to run again)
//   npm run seed -- --reset → WIPES the database first, then seeds (never in production)
//
// All test users get the password: Passord123!
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const {
  User, Company, Category, ProProfile, Client, Job,
  Offer, Contract, Milestone, TimeEntry, Conversation, Message, Review, Payment, Invoice, Notification,
} = await import('../src/models/index.js');

const ALL_MODELS = [
  User, Company, Category, ProProfile, Client, Job,
  Offer, Contract, Milestone, TimeEntry, Conversation, Message, Review, Payment, Invoice, Notification,
];

const RESET = process.argv.includes('--reset');
const PASSWORD = 'Passord123!';
const BERGEN = [5.3221, 60.3913]; // [lng, lat]

// ---------------------------------------------------------------------------
// Categories: [name, slug, workType, icon, requiresCertification, children]
// ---------------------------------------------------------------------------
const CATEGORIES = [
  ['Elektriker', 'elektriker', 'onsite', 'flash', true, [
    ['Sikringsskap', 'sikringsskap'],
    ['Stikkontakter og lys', 'stikkontakter-og-lys'],
    ['Elbillader', 'elbillader'],
  ]],
  ['Rørlegger', 'rorlegger', 'onsite', 'water', true, [
    ['Bad', 'bad'],
    ['Varmtvannsbereder', 'varmtvannsbereder'],
    ['Lekkasje', 'lekkasje'],
  ]],
  ['Snekker', 'snekker', 'onsite', 'hammer', false, [
    ['Terrasse', 'terrasse'],
    ['Kjøkkenmontering', 'kjokkenmontering'],
    ['Vinduer og dører', 'vinduer-og-dorer'],
  ]],
  ['Maler', 'maler', 'onsite', 'brush', false, []],
  ['Flislegger', 'flislegger', 'onsite', 'grid', false, []],
  ['Renhold', 'renhold', 'onsite', 'sparkles', false, [
    ['Flyttevask', 'flyttevask'],
    ['Fast renhold', 'fast-renhold'],
  ]],
  ['Flytting', 'flytting', 'onsite', 'truck', false, []],
  ['Hage', 'hage', 'onsite', 'leaf', false, [
    ['Plenklipp', 'plenklipp'],
    ['Hekk og trær', 'hekk-og-traer'],
  ]],
  ['IT og utvikling', 'it-og-utvikling', 'remote', 'code', false, [
    ['Nettside', 'nettside'],
    ['App', 'app'],
    ['IT-support', 'it-support'],
  ]],
  ['Design', 'design', 'remote', 'palette', false, [
    ['Logo og profil', 'logo-og-profil'],
    ['Grafisk design', 'grafisk-design'],
  ]],
  ['Regnskap', 'regnskap', 'remote', 'calculator', false, []],
];

const USERS = {
  admin: { email: 'admin@qupwork.test', name: 'Admin Qup', roles: ['customer', 'admin'] },
  kunde: { email: 'kunde@qupwork.test', name: 'Kari Kunde', roles: ['customer'], phone: '91234567' },
  pro: {
    email: 'pro@qupwork.test', name: 'Ola Elektriker', roles: ['customer', 'pro'],
    activeRole: 'pro', phone: '98765432',
  },
  ansatt: {
    email: 'ansatt@qupwork.test', name: 'Per Ansatt', roles: ['customer', 'pro'],
    activeRole: 'pro', phone: '99887766',
  },
};

// ---------------------------------------------------------------------------
const log = (icon, text) => console.log(`  ${icon} ${text}`);

async function upsertCategory([name, slug, workType, icon, requiresCertification], parent, sortOrder) {
  return Category.findOneAndUpdate(
    { slug },
    {
      $set: {
        name, slug, workType, icon, sortOrder, active: true,
        requiresCertification: requiresCertification ?? false,
        parent: parent?._id ?? null,
      },
    },
    { upsert: true, new: true, runValidators: true }
  );
}

async function seedCategories() {
  const bySlug = {};
  for (const [i, def] of CATEGORIES.entries()) {
    const [name, slug, workType, icon, cert, children] = def;
    const parent = await upsertCategory([name, slug, workType, icon, cert], null, i);
    bySlug[slug] = parent;
    for (const [j, [childName, childSlug]] of children.entries()) {
      bySlug[childSlug] = await upsertCategory(
        [childName, `${slug}-${childSlug}`, workType, icon, cert],
        parent,
        j
      );
    }
  }
  log('✅', `${Object.keys(bySlug).length} categories`);
  return bySlug;
}

async function upsertUser(data) {
  let user = await User.findOne({ email: data.email }).select('+password');
  const isNew = !user;
  if (isNew) user = new User({ email: data.email });
  user.set({ ...data, password: PASSWORD, status: 'active' }); // password is re-hashed on save
  await user.save();
  return user;
}

async function seedUsers() {
  const users = {};
  for (const [key, data] of Object.entries(USERS)) users[key] = await upsertUser(data);
  log('✅', `${Object.keys(users).length} users`);
  return users;
}

async function seedCompany(users) {
  let company = await Company.findOne({ owner: users.pro._id, name: 'Bergen Elektro AS' });
  if (!company) company = new Company({ owner: users.pro._id, name: 'Bergen Elektro AS' });

  company.set({
    orgNumber: '999888777',
    orgForm: 'AS',
    vatRegistered: true,
    email: 'post@bergenelektro.test',
    phone: '55123456',
    address: { line1: 'Kanalveien 10', postalCode: '5068', city: 'Bergen', municipality: 'Bergen' },
    members: [
      { user: users.pro._id, role: 'owner' },
      { user: users.ansatt._id, role: 'worker', hourlyCost: 45000 },
    ],
  });
  company.set('invoiceSettings.bankAccount', '12345678903');
  company.set('invoiceSettings.paymentTermsDays', 14);
  await company.save();
  log('✅', `company "${company.name}" (pro = owner, ansatt = worker)`);
  return company;
}

async function seedProProfile(users, company, cats) {
  const profile = await ProProfile.findOneAndUpdate(
    { user: users.pro._id },
    {
      $set: {
        company: company._id,
        headline: 'Autorisert elektriker i Bergen, 15 års erfaring',
        bio: 'Vi tar alt fra nye stikkontakter til sikringsskap og elbilladere. Rask respons og ryddig arbeid.',
        categories: [cats.elektriker, cats.sikringsskap, cats['stikkontakter-og-lys'], cats.elbillader].map(
          (c) => c._id
        ),
        skills: ['sikringsskap', 'elbillader', 'smarthus'],
        workType: 'onsite',
        serviceArea: {
          location: { type: 'Point', coordinates: BERGEN },
          radiusKm: 40,
          municipalities: ['Bergen', 'Askøy', 'Bjørnafjorden'],
        },
        hourlyRate: 95000,
        availableForMarketplace: true,
        'verification.orgNumberVerified': true,
      },
    },
    { upsert: true, new: true, runValidators: true }
  );
  log('✅', 'pro profile (visible in the marketplace)');
  return profile;
}

async function seedClient(users, company) {
  const client = await Client.findOneAndUpdate(
    { owner: users.pro._id, name: 'Nils Nordmann' },
    {
      $set: {
        company: company._id,
        type: 'private',
        phone: '45678901',
        email: 'nils@example.test',
        address: { line1: 'Storgata 1', postalCode: '5003', city: 'Bergen' },
        location: { type: 'Point', coordinates: [5.3255, 60.3925] },
        notes: 'Ring før du kommer. Hund i huset.',
      },
    },
    { upsert: true, new: true, runValidators: true }
  );
  log('✅', `client "${client.name}" (owned by pro)`);
  return client;
}

async function seedJobs(users, company, client, cats) {
  const jobs = [
    {
      find: { customer: users.kunde._id, title: 'Montere elbillader i garasje' },
      data: {
        source: 'marketplace',
        createdBy: users.kunde._id,
        customer: users.kunde._id,
        description: 'Har en Tesla og trenger 11 kW lader i garasjen. Sikringsskapet er fra 2015.',
        category: cats.elbillader._id,
        workType: 'onsite',
        address: { line1: 'Fjellveien 20', postalCode: '5019', city: 'Bergen' },
        location: { type: 'Point', coordinates: [5.335, 60.401] },
        budget: { min: 1500000, max: 2500000 },
        timing: { urgency: 'within_month' },
        status: 'open',
        visibility: 'public',
        publishedAt: new Date(),
      },
    },
    {
      find: { customer: users.kunde._id, title: 'Male stue og gang' },
      data: {
        source: 'marketplace',
        createdBy: users.kunde._id,
        customer: users.kunde._id,
        description: 'Ca. 60 m² veggflate. Lys farge, to strøk.',
        category: cats.maler._id,
        address: { line1: 'Fjellveien 20', postalCode: '5019', city: 'Bergen' },
        location: { type: 'Point', coordinates: [5.335, 60.401] },
        timing: { urgency: 'flexible' },
        status: 'draft',
        visibility: 'public',
      },
    },
    {
      find: { client: client._id, title: 'Bytte sikringsskap' },
      data: {
        source: 'direct',
        createdBy: users.pro._id,
        pro: users.pro._id,
        company: company._id,
        description: 'Gammelt skap med skrusikringer. Nytt skap med jordfeilbrytere.',
        category: cats.sikringsskap._id,
        address: client.address?.toObject(),
        location: client.location?.toObject(),
        status: 'draft',
        visibility: 'private',
      },
    },
  ];

  for (const { find, data } of jobs) {
    const exists = await Job.findOne(find);
    if (exists) continue;
    await Job.create({ ...find, ...data });
  }
  log('✅', '3 jobs (1 open in the marketplace, 1 draft, 1 direct for the client)');
}

// ---------------------------------------------------------------------------
async function main() {
  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI missing. Put it in .env in the project folder.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const { host, name } = mongoose.connection;
  console.log(`\n🌱 Seeding ${host}/${name}\n`);

  if (RESET) {
    if (process.env.NODE_ENV === 'production') {
      console.error('❌ Refusing to reset a production database.');
      process.exit(1);
    }
    await mongoose.connection.dropDatabase();
    log('🗑️ ', 'database wiped');
  }

  // Make sure all indexes exist (important after --reset)
  await Promise.all(ALL_MODELS.map((m) => m.createIndexes()));

  const cats = await seedCategories();
  const users = await seedUsers();
  const company = await seedCompany(users);
  await seedProProfile(users, company, cats);
  const client = await seedClient(users, company);
  await seedJobs(users, company, client, cats);

  console.log(`
👤 Test logins (password for all: ${PASSWORD})
   admin@qupwork.test   admin, can manage categories
   kunde@qupwork.test   customer with an open job in the marketplace
   pro@qupwork.test     pro, owner of Bergen Elektro AS, has a client
   ansatt@qupwork.test  pro, worker in Bergen Elektro AS

🔑 Log in from the terminal:
   TOKEN=$(curl -s -X POST localhost:${process.env.PORT ?? 4000}/api/v1/auth/login \\
     -H "Content-Type: application/json" \\
     -d '{"email":"pro@qupwork.test","password":"${PASSWORD}"}' \\
     | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')
`);

  if (RESET) {
    console.log('⚠️  If the server is running, restart it so it reconnects cleanly.\n');
  }
}

try {
  await main();
} catch (err) {
  console.error('\n❌ Seed failed:', err.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
