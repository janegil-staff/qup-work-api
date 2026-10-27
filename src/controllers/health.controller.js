// /qup-work-api/src/controllers/health.controller.js
import mongoose from 'mongoose';

const DB_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

// GET /api/v1/health
export const getHealth = (req, res) => {
  const dbState = DB_STATES[mongoose.connection.readyState] ?? 'unknown';

  res.status(dbState === 'connected' ? 200 : 503).json({
    status: dbState === 'connected' ? 'ok' : 'degraded',
    db: dbState,
    uptime: Math.round(process.uptime()),
    time: new Date().toISOString(),
  });
};
