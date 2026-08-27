'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const mailer = require('../mailer');
const { issueSession, clearSession, requireAuth } = require('../auth-mw');
const { getNotificationRequirements, accountToPublic } = require('../lib/account-helpers');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const codeLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Too many code requests — please wait a few minutes.' } });
const verifyLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Too many attempts — please wait a few minutes.' } });

function genCode() { return String(Math.floor(1000 + Math.random() * 9000)); }

// POST /api/auth/request-code { email }
router.post('/request-code', codeLimiter, async (req, res) => {
  const email = (req.body.email || '').trim();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });

  const code = genCode();
  db.setCode(email, code, 5 * 60 * 1000);

  const mailResult = await mailer.sendMail({ to: email, subject: 'Your B2B SWAP verification code',
    text: `Your B2B SWAP verification code is ${code}. It expires in 5 minutes.` });

  const payload = { ok: true, emailSent: mailResult.sent };
  // Only ever expose the raw code outside of production, and only when email
  // genuinely isn't wired up — this keeps local development usable without
  // an SMTP account, while never leaking codes on a real deployment.
  if (process.env.NODE_ENV !== 'production' && !mailResult.sent) {
    payload.devCode = code;
    payload.devNote = 'Email is not connected in this environment — showing the code here for local testing only.';
  }
  res.json(payload);
});

// POST /api/auth/verify { email, code }
router.post('/verify', verifyLimiter, (req, res) => {
  const email = (req.body.email || '').trim();
  const code = (req.body.code || '').trim();
  if (!email || !code) return res.status(400).json({ error: 'missing_fields' });
  if (!db.checkCode(email, code)) return res.status(400).json({ error: 'invalid_or_expired_code' });

  const acc = db.upsertAccountVerified(email);
  issueSession(res, acc.id);
  res.json({ ok: true, account: accountToPublic(acc) });
});

// GET /api/me
router.get('/me', (req, res) => {
  if (!req.account) return res.json({ account: null });
  res.json({
    account: accountToPublic(req.account),
    notifications: getNotificationRequirements(req.account),
  });
});

// POST /api/auth/profile { company, phone }
router.post('/profile', requireAuth, (req, res) => {
  const company = (req.body.company || '').trim();
  const phone = (req.body.phone || '').trim();
  if (!company) return res.status(400).json({ error: 'missing_fields' });

  const acc = db.updateAccountProfile(req.account.id, { company, phone: phone || null });
  res.json({ ok: true, account: accountToPublic(acc), notifications: getNotificationRequirements(acc) });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

module.exports = router;
