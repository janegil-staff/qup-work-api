// /qup-work-api/src/utils/AppError.js
// Throw this anywhere in a controller to send a clean error response.

export class AppError extends Error {
  constructor(message, statusCode = 400, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }

  static notFound(what = 'Resource') {
    return new AppError(`${what} not found`, 404);
  }

  static unauthorized(msg = 'Not authenticated') {
    return new AppError(msg, 401);
  }

  static forbidden(msg = 'Not allowed') {
    return new AppError(msg, 403);
  }
}
