/* =====================================================================
   B2B SWAP — session handling (JWT in an httpOnly cookie)
   ===================================================================== */
'use strict';

const jwt = require('jsonwebtoken');
const db = require('./db');

const COOKIE_NAME = 'b2bswap_session';
const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 16) {
  console.warn('[auth] JWT_SECRET is missing or too short — set a long random value in .env before deploying.');
}

function issueSession(res, accountId) {
  const token = jwt.sign({ aid: accountId }, SECRET || 'dev-only-insecure-secret', { expiresIn: '30d' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}
function clearSession(res) {
  res.clearCookie(COOKIE_NAME);
}

/** Attaches req.account if a valid session cookie is present. Never blocks
 *  the request — routes that require login check req.account themselves. */
function attachAccount(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (token) {
    try {
      const payload = jwt.verify(token, SECRET || 'dev-only-insecure-secret');
      req.account = db.getAccountById(payload.aid) || null;
    } catch (e) {
      req.account = null;
    }
  } else {
    req.account = null;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.account) return res.status(401).json({ error: 'not_authenticated' });
  next();
}
function requireVerifiedProfile(req, res, next) {
  if (!req.account) return res.status(401).json({ error: 'not_authenticated' });
  if (!req.account.verified) return res.status(403).json({ error: 'phone_not_verified' });
  if (!req.account.company || !req.account.email) return res.status(403).json({ error: 'profile_incomplete' });
  next();
}

module.exports = { issueSession, clearSession, attachAccount, requireAuth, requireVerifiedProfile, COOKIE_NAME };
