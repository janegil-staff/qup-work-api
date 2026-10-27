// /qup-work-api/src/config/db.js
import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectDB() {
  mongoose.set('strictQuery', true);

  mongoose.connection.on('connected', () => {
    const { host, name } = mongoose.connection;
    console.log(`✅ MongoDB connected: ${host}/${name}`);
  });
  mongoose.connection.on('error', (err) => console.error('❌ MongoDB error:', err.message));
  mongoose.connection.on('disconnected', () => console.warn('⚠️  MongoDB disconnected'));

  await mongoose.connect(env.mongoUri, {
    autoIndex: !env.isProd, // build indexes automatically in dev only
    serverSelectionTimeoutMS: 10000, // fail fast if Mongo isn't reachable
  });
}

export async function disconnectDB() {
  await mongoose.connection.close();
}
