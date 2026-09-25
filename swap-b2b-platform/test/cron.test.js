'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
require('express-async-errors');
const { createCronRouter } = require('../routes/cron');

async function serve(supabase) {
  const app = express();
  app.use('/api/cron', createCronRouter({ supabase }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  return { server, url: `http://127.0.0.1:${server.address().port}/api/cron/keepalive` };
}
function fakeSupabase(result, calls) {
  const q = { select: (...a) => { calls.push(['select', ...a]); return q; }, limit: (n) => { calls.push(['limit', n]); return Promise.resolve(result); } };
  return { from: (t) => { calls.push(['from', t]); return q; } };
}

test('keepalive runs one tiny query and reports ok', async (t) => {
  delete process.env.CRON_SECRET;
  const calls = [];
  const { server, url } = await serve(fakeSupabase({ error: null }, calls));
  t.after(() => server.close());
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.deepEqual(calls[0], ['from', 'accounts']);
});

test('keepalive requires the Vercel CRON_SECRET bearer when set', async (t) => {
  process.env.CRON_SECRET = 's3cret-value';
  t.after(() => { delete process.env.CRON_SECRET; });
  const { server, url } = await serve(fakeSupabase({ error: null }, []));
  t.after(() => server.close());
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer s3cret-value' } })).status, 200);
});

test('keepalive surfaces an unreachable database as 503', async (t) => {
  const { server, url } = await serve(fakeSupabase({ error: { message: 'fetch failed' } }, []));
  t.after(() => server.close());
  const res = await fetch(url);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'database_unreachable');
});
