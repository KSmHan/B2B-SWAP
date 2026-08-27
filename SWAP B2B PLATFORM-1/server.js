'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
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
app.set('trust proxy', 1); // needed behind Render/Railway/Heroku-style proxies for correct client IPs & secure cookies

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

app.use(express.static(path.join(__dirname, 'public')));

// SPA-ish fallback for the four static pages (direct links, refreshes, etc.)
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/how-it-works.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'how-it-works.html')));
app.get('/catalog.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'catalog.html')));
app.get('/account.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'account.html')));

app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'internal_error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`B2B SWAP server listening on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  if (!require('./mailer').isConfigured) console.warn('  → email notifications are DISABLED until SMTP_* is set in .env');
  if (!require('./sms').isConfigured) console.warn('  → SMS notifications are DISABLED until TWILIO_* is set in .env');
});
