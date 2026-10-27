// /qup-work-api/src/utils/tokens.js
// Access token: short-lived, sent on every request (Authorization: Bearer <token>)
// Refresh token: long-lived, only used to get a new access token
// "tv" (token version) lets us log a user out of every device by bumping user.tokenVersion
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

const payloadFor = (user) => ({ sub: user._id.toString(), tv: user.tokenVersion ?? 0 });

export const signAccessToken = (user) =>
  jwt.sign(payloadFor(user), env.jwtAccessSecret, { expiresIn: env.accessTokenTtl });

export const signRefreshToken = (user) =>
  jwt.sign(payloadFor(user), env.jwtRefreshSecret, { expiresIn: env.refreshTokenTtl });

export const verifyAccessToken = (token) => jwt.verify(token, env.jwtAccessSecret);
export const verifyRefreshToken = (token) => jwt.verify(token, env.jwtRefreshSecret);

export const issueTokens = (user) => ({
  accessToken: signAccessToken(user),
  refreshToken: signRefreshToken(user),
});
