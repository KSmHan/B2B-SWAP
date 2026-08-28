'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — ' +
    'db.js calls will fail until they are configured. See supabase/SETUP.md.');
}

// createClient() throws synchronously on a missing/invalid URL, which would
// otherwise crash the whole app at import time (every route file requires
// db.js, which requires this module) instead of failing only the specific
// request that needed the database — same crash-at-boot risk the warning
// above is trying to surface gracefully instead. Falling back to a
// syntactically valid placeholder keeps construction safe; an actual
// unconfigured deployment still fails loudly, but per-request, at the
// first real query, the same way mailer.js/sms.js degrade.
const url = SUPABASE_URL || 'https://placeholder.supabase.co';
const key = SUPABASE_SERVICE_ROLE_KEY || 'placeholder-service-role-key';

// Server-side only — the service role key bypasses Row Level Security and
// must never be sent to the frontend. auth: {persistSession:false} because
// this client is a shared singleton across requests, not per-user.
const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

module.exports = supabase;
