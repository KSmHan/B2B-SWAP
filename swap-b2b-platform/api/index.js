'use strict';

// Vercel Function entry point. This single function handles every
// /api/* request — vercel.json rewrites /api/(.*) here with the full
// original path preserved in the request Vercel hands to Express, so
// server-app.js's existing app.use('/api/auth', ...) etc. mounting
// keeps working completely unchanged — no route paths change.
// app.listen() is never called here; Vercel invokes the exported
// Express app directly as the request handler.

const app = require('../server-app');

module.exports = app;
