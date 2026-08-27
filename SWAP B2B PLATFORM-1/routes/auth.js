'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const sms = require('../sms');
const mailer = require('../mailer');
const { issueSession, clearSession, requireAuth } = require('../auth-mw');
const { getNotificationRequirements, accountToPublic } = require('../lib/account-helpers');

const router = express.Router();

const codeLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Too many code requests — please wait a few minutes.' } });
const verifyLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Too many attempts — please wait a few minutes.' } });

function genCode() { return String(Math.floor(1000 + Math.random() * 9000)); }

// POST /api/auth/request-code { phone }
router.post('/request-code', codeLimiter, async (req, res) => {
  const phone = (req.body.phone || '').trim();
  if (phone.length < 7) return res.status(400).json({ error: 'invalid_phone' });

  const code = genCode();
  db.setCode(phone, code, 5 * 60 * 1000);

  const smsResult = await sms.sendSms({ to: phone, body: `Your B2B SWAP verification code is ${code}. It expires in 5 minutes.` });

  const payload = { ok: true, smsSent: smsResult.sent };
  // Only ever expose the raw code outside of production, and only when SMS
  // genuinely isn't wired up — this keeps local development usable without
  // a Twilio account, while never leaking codes on a real deployment.
  if (process.env.NODE_ENV !== 'production' && !smsResult.sent) {
    payload.devCode = code;
    payload.devNote = 'SMS is not connected in this environment — showing the code here for local testing only.';
  }
  res.json(payload);
});

// POST /api/auth/verify { phone, code }
router.post('/verify', verifyLimiter, (req, res) => {
  const phone = (req.body.phone || '').trim();
  const code = (req.body.code || '').trim();
  if (!phone || !code) return res.status(400).json({ error: 'missing_fields' });
  if (!db.checkCode(phone, code)) return res.status(400).json({ error: 'invalid_or_expired_code' });

  const acc = db.upsertAccountVerified(phone);
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

// POST /api/auth/profile { company, email }
router.post('/profile', requireAuth, async (req, res) => {
  const company = (req.body.company || '').trim();
  const email = (req.body.email || '').trim();
  if (!company || !email) return res.status(400).json({ error: 'missing_fields' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });

  const wasNewEmail = req.account.email !== email;
  const acc = db.updateAccountProfile(req.account.id, { company, email });

  if (wasNewEmail) {
    await mailer.sendMail({
      to: email,
      subject: 'Your B2B SWAP email is connected',
      text: `Hi ${company},\n\nThis address is now connected to your B2B SWAP account. You'll receive an email here whenever a company confirms interest in a trade with you.\n\n— B2B SWAP`,
    });
  }
  res.json({ ok: true, account: accountToPublic(acc), notifications: getNotificationRequirements(acc) });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

module.exports = router;
