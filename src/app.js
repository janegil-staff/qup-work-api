// /qup-work-api/src/app.js
// Builds the Express app (no listen here, so it's easy to test).
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import routes from './routes/index.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // correct client IPs behind a hosting proxy

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins.length ? env.corsOrigins : true,
      credentials: true,
    })
  );
  app.use(express.json({ limit: '1mb' }));
  // The app polls these every few seconds while a chat is open; don't fill the log with them
  const isPoll = (req, res) =>
    req.method === 'GET' &&
    res.statusCode < 400 &&
    /\/conversations\/(unread|[a-f0-9]{24}\/messages\?limit=\d+)$/.test(req.originalUrl);
  app.use(morgan(env.isProd ? 'combined' : 'dev', { skip: env.isProd ? undefined : isPoll }));

  app.use('/api/v1', routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
