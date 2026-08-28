'use strict';

// Local-development entry point only. app.listen() must never run in the
// Vercel runtime — api/[...path].js imports server-app.js directly and
// exports it as the request handler instead. See supabase/SETUP.md for
// the Vercel deployment path.

const app = require('./server-app');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`B2B SWAP server listening on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  if (!require('./mailer').isConfigured) console.warn('  → email notifications are DISABLED until SMTP_* is set in .env');
  if (!require('./sms').isConfigured) console.warn('  → SMS notifications are DISABLED until TWILIO_* is set in .env');
});
