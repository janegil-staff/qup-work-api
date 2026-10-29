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

// Its own secret, so a file link can never pass as a login token
const fileSecret = () => `${env.jwtAccessSecret}:files`;

// Short-lived token for opening one file in a browser (e.g. an invoice PDF)
export const signFileToken = (claims) => jwt.sign({ ...claims, purpose: 'file' }, fileSecret(), { expiresIn: '10m' });
export function verifyFileToken(token, kind) {
  try {
    const claims = jwt.verify(token, fileSecret());
    return claims.purpose === 'file' && claims.kind === kind ? claims : null;
  } catch {
    return null;
  }
}

export const issueTokens = (user) => ({
  accessToken: signAccessToken(user),
  refreshToken: signRefreshToken(user),
});
