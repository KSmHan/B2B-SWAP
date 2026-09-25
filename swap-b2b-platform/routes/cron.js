/* =====================================================================
   B2B SWAP — scheduled jobs (Vercel Cron, see "crons" in vercel.json).

   GET /api/cron/keepalive — one tiny query against Supabase once a day.
   Free-plan Supabase projects are paused after a week without database
   activity, which takes the whole site down (every /api call fails with
   "fetch failed"). A daily read keeps the project awake.

   Vercel sends "Authorization: Bearer $CRON_SECRET" on cron invocations
   when CRON_SECRET is set in the project; set it so nobody else can
   trigger the job.
   ===================================================================== */
'use strict';

const crypto = require('crypto');
const express = require('express');

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // harmless read-only job; set CRON_SECRET to lock it down
  const got = Buffer.from(req.get('Authorization') || '');
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function createCronRouter({ supabase = require('../lib/supabase') } = {}) {
  const router = express.Router();

  router.get('/keepalive', async (req, res) => {
    if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
    const started = Date.now();
    const { error } = await supabase.from('accounts').select('id', { head: true, count: 'exact' }).limit(1);
    if (error) {
      console.error('[cron] keepalive failed:', error.message);
      return res.status(503).json({ ok: false, error: 'database_unreachable' });
    }
    res.json({ ok: true, ms: Date.now() - started });
  });

  return router;
}

module.exports = { createCronRouter };
