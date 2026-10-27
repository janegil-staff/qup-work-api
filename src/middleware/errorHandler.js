// /qup-work-api/src/middleware/errorHandler.js
import mongoose from 'mongoose';
import { AppError } from '../utils/AppError.js';
import { env } from '../config/env.js';

export function notFound(req, res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
}

// Express 5 forwards errors from async controllers here automatically,
// so controllers don't need try/catch.
export function errorHandler(err, req, res, next) {
  let status = err.statusCode ?? 500;
  let message = err.message ?? 'Something went wrong';
  let details = err.details;

  if (err instanceof mongoose.Error.ValidationError) {
    status = 400;
    message = 'Validation failed';
    details = Object.fromEntries(
      Object.entries(err.errors).map(([field, e]) => [field, e.message])
    );
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    message = `Invalid ${err.path}: ${err.value}`;
  } else if (err.code === 11000) {
    status = 409;
    message = `Already exists: ${Object.keys(err.keyValue ?? {}).join(', ')}`;
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Invalid JSON in request body';
  }

  if (status >= 500) console.error(err);

  res.status(status).json({
    error: {
      message: status >= 500 && env.isProd ? 'Internal server error' : message,
      ...(details && { details }),
      ...(!env.isProd && status >= 500 && { stack: err.stack }),
    },
  });
}
