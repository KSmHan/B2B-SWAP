'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
require('express-async-errors'); // Express 4 doesn't forward a rejected promise from an async handler to the error middleware on its own — this patches it to do so, now that db.js's Supabase calls are async.
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { attachAccount } = require('./auth-mw');
const authRoutes = require('./routes/auth');
const { router: listingsRoutes } = require('./routes/listings');
const agentRoutes = require('./routes/agent');
const dealsRoutes = require('./routes/deals');

const app = express();
app.set('trust proxy', 1); // needed behind Render/Railway/Heroku/Vercel-style proxies for correct client IPs & secure cookies

app.use(helmet({
  contentSecurityPolicy: false, // the frontend is plain HTML/CSS/JS served from this same origin; enable/tune CSP once your asset list is final
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(attachAccount);

// Basic global rate limit as a safety net; auth routes have their own, tighter limits.
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false }));

app.use('/api/auth', authRoutes);
app.use('/api/listings', listingsRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/deals', dealsRoutes);

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    emailConfigured: require('./mailer').isConfigured,
    smsConfigured: require('./sms').isConfigured,
  });
});

// Static frontend + page routes — only reached in local dev. On Vercel these
// paths are served directly from public/ via vercel.json rewrites, so a
// request never reaches this app for them (and this file is named
// server-app.js, not app.js, specifically so it can never collide with
// the actual frontend script at public/app.js); kept here so `npm start`
// still serves the full site unchanged.
app.use(express.static(path.join(__dirname, 'public')));

app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/how-it-works.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'how-it-works.html')));
app.get('/catalog.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'catalog.html')));
app.get('/account.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'account.html')));

app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'internal_error' });
});

module.exports = app;
