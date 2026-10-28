// /qup-work-api/scripts/reset-db.js
// Empties the database. Asks you to type the database name before deleting anything.
//
//   npm run db:reset                       → delete ALL documents (collections + indexes are kept)
//   npm run db:reset -- --keep-categories  → everything except categories
//   npm run db:reset -- --drop             → drop the whole database (indexes too)
//   npm run db:reset -- --yes              → skip the confirmation (for scripts)
//
// Refuses to run when NODE_ENV=production.
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const args = process.argv.slice(2);
const DROP = args.includes('--drop');
const KEEP_CATEGORIES = args.includes('--keep-categories');
const YES = args.includes('--yes');

if (process.env.NODE_ENV === 'production') {
  console.error('❌ Refusing to empty a database when NODE_ENV=production.');
  process.exit(1);
}
if (!process.env.MONGO_URI) {
  console.error('❌ MONGO_URI missing. Put it in .env in the project folder.');
  process.exit(1);
}
if (DROP && KEEP_CATEGORIES) {
  console.error('❌ --drop and --keep-categories can\'t be combined.');
  process.exit(1);
}

async function confirm(dbName) {
  if (YES) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\n⚠️  This cannot be undone. Type the database name "${dbName}" to continue: `);
  rl.close();
  return answer.trim() === dbName;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const db = mongoose.connection.db;
  const { host, name } = mongoose.connection;

  const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .sort();

  console.log(`\n🗄️  ${host}/${name}\n`);
  if (!collections.length) {
    console.log('  The database is already empty.\n');
    return;
  }

  const counts = {};
  for (const c of collections) counts[c] = await db.collection(c).countDocuments();
  const targets = collections.filter((c) => !(KEEP_CATEGORIES && c === 'categories'));

  for (const c of collections) {
    const keep = !targets.includes(c);
    console.log(`  ${keep ? '🔒' : '🗑️ '} ${c.padEnd(16)} ${String(counts[c]).padStart(6)} ${keep ? '(kept)' : ''}`);
  }
  const total = targets.reduce((s, c) => s + counts[c], 0);
  console.log(
    `\n  ${DROP ? `Will DROP the whole database "${name}"` : `Will delete ${total} document(s) from ${targets.length} collection(s)`}`
  );

  if (!(await confirm(name))) {
    console.log('\n✋ Cancelled, nothing was deleted.\n');
    return;
  }

  if (DROP) {
    await db.dropDatabase();
    console.log(`\n✅ Database "${name}" dropped.`);
    console.log('   Restart the server (or run npm run seed) so the indexes are created again.\n');
    return;
  }

  for (const c of targets) await db.collection(c).deleteMany({});
  console.log(`\n✅ Deleted ${total} document(s). Collections and indexes are kept.`);
  console.log('   Run "npm run seed" to add test data again.\n');
}

try {
  await main();
} catch (err) {
  console.error('\n❌ Reset failed:', err.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
