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
};

export const cloudinaryReady = () =>
  Boolean(env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret);
