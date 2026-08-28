'use strict';

// Vercel Function entry point. The catch-all filename routes every
// /api/* request here with the full original req.url intact, so
// server-app.js's existing app.use('/api/auth', ...) etc. mounting
// keeps working completely unchanged — no route paths change.
// app.listen() is never called here; Vercel invokes the exported
// Express app directly as the request handler.

const app = require('../server-app');

module.exports = app;
