// /qup-work-api/src/middleware/auth.js
import { User } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { verifyAccessToken } from '../utils/tokens.js';

async function userFromRequest(req) {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) return null;

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw AppError.unauthorized('Invalid or expired token');
  }

  const user = await User.findById(payload.sub).select('+tokenVersion');
  if (!user || user.status !== 'active' || user.tokenVersion !== payload.tv) {
    throw AppError.unauthorized('Session is no longer valid, please log in again');
  }
  return user;
}

// Route needs a logged-in user → sets req.user
export async function requireAuth(req, res, next) {
  const user = await userFromRequest(req);
  if (!user) throw AppError.unauthorized();
  req.user = user;
  next();
}

// Public route that behaves a bit differently when logged in
export async function optionalAuth(req, res, next) {
  try {
    req.user = (await userFromRequest(req)) ?? undefined;
  } catch {
    req.user = undefined; // bad token on a public route → treat as anonymous
  }
  next();
}

// Use after requireAuth: requireRole('pro'), requireRole('admin')
export const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!roles.some((r) => req.user?.roles?.includes(r))) {
      throw AppError.forbidden(`Requires role: ${roles.join(' or ')}`);
    }
    next();
  };
