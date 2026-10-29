// /qup-work-api/src/controllers/auth.controller.js
import { User, Company, ProProfile } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { pick } from '../utils/http.js';
import { issueTokens, verifyRefreshToken } from '../utils/tokens.js';
import { cleanImageUrl } from '../utils/uploads.js';

// POST /auth/register
export const register = async (req, res) => {
  const data = pick(req.body, ['email', 'password', 'name', 'phone']);
  const user = await User.create(data);
  res.status(201).json({ user, ...issueTokens(user) });
};

// POST /auth/login
export const login = async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) throw new AppError('Email and password are required', 400);

  const user = await User.findOne({ email: String(email).toLowerCase().trim() }).select(
    '+password +tokenVersion'
  );
  if (!user || !(await user.comparePassword(String(password)))) {
    throw AppError.unauthorized('Invalid email or password');
  }
  if (user.status !== 'active') throw AppError.forbidden('This account is not active');

  user.lastLoginAt = new Date();
  await user.save();

  res.json({ user, ...issueTokens(user) });
};

// POST /auth/refresh  { refreshToken }
export const refresh = async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (!refreshToken) throw new AppError('refreshToken is required', 400);

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw AppError.unauthorized('Invalid or expired refresh token');
  }

  const user = await User.findById(payload.sub).select('+tokenVersion');
  if (!user || user.status !== 'active' || user.tokenVersion !== payload.tv) {
    throw AppError.unauthorized('Session is no longer valid, please log in again');
  }
  res.json(issueTokens(user));
};

// POST /auth/logout → logs out ALL devices
export const logout = async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
  res.status(204).end();
};

// GET /auth/me
export const getMe = async (req, res) => {
  const uid = req.user._id;
  const [companies, proProfile] = await Promise.all([
    Company.find({ 'members.user': uid }).select('name orgNumber logoUrl members'),
    ProProfile.findOne({ user: uid }).populate('categories', 'name slug icon'),
  ]);

  res.json({
    user: req.user,
    companies: companies.map((c) => ({
      _id: c._id,
      name: c.name,
      orgNumber: c.orgNumber,
      logoUrl: c.logoUrl,
      role: c.getMemberRole(uid),
    })),
    proProfile,
  });
};

// PATCH /auth/me
export const updateMe = async (req, res) => {
  const data = pick(req.body, ['name', 'phone', 'avatarUrl', 'address', 'location', 'activeRole']);
  if (data.avatarUrl !== undefined) data.avatarUrl = cleanImageUrl(data.avatarUrl, 'avatarUrl');
  if (data.activeRole === 'pro' && !req.user.roles.includes('pro')) {
    throw new AppError('Create a pro profile or company before switching to pro mode', 400);
  }
  req.user.set(data);
  await req.user.save();
  res.json({ user: req.user });
};

// POST /auth/me/password  { currentPassword, newPassword }
export const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (!currentPassword || !newPassword) {
    throw new AppError('currentPassword and newPassword are required', 400);
  }

  const user = await User.findById(req.user._id).select('+password +tokenVersion');
  if (!(await user.comparePassword(String(currentPassword)))) {
    throw AppError.unauthorized('Current password is wrong');
  }

  user.password = newPassword;
  user.tokenVersion += 1; // logs out other devices
  await user.save();

  res.json(issueTokens(user)); // this device stays logged in
};

// POST /auth/me/push-tokens  { token, platform }
export const addPushToken = async (req, res) => {
  const { token, platform } = req.body ?? {};
  if (!token) throw new AppError('token is required', 400);

  await User.updateOne({ _id: req.user._id }, { $pull: { pushTokens: { token } } });
  await User.updateOne(
    { _id: req.user._id },
    {
      $push: {
        pushTokens: { $each: [{ token, platform, createdAt: new Date() }], $slice: -10 },
      },
    }
  );
  res.status(204).end();
};

// DELETE /auth/me/push-tokens  { token }  (call on logout in the app)
export const removePushToken = async (req, res) => {
  const { token } = req.body ?? {};
  if (!token) throw new AppError('token is required', 400);
  await User.updateOne({ _id: req.user._id }, { $pull: { pushTokens: { token } } });
  res.status(204).end();
};
