/* =====================================================================
   B2B SWAP — persistence layer

   Backed by Supabase/Postgres (see supabase/schema.sql) instead of a
   local file — a Vercel serverless function has no reliable, shared
   filesystem to persist accounts, verification codes, listings, or
   deals across invocations. Every other file only talks to the
   functions exported here, so the rest of the app does not need to
   change beyond awaiting these calls.
   ===================================================================== */
'use strict';

const { customAlphabet } = require('nanoid');
const supabase = require('./lib/supabase');

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

/* ---------------- Row <-> app-object mapping ----------------
   The rest of the app (routes, matching.js's seed listings, the
   frontend) uses the same camelCase field names it always has —
   these mappings are the only place that knows about the DB's
   snake_case columns. */
function rowToAccount(r) {
  if (!r) return null;
  return {
    id: r.id, email: r.email, phone: r.phone, company: r.company, verified: r.verified,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : undefined,
  };
}
function listingToRow(l) {
  return {
    id: l.id, cat: l.cat, title: l.title, qty: l.qty, condition: l.condition,
    description: l.desc, price: l.price, specs: l.specs, tags: l.tags,
    wants_text: l.wantsText, want_tokens: l.wantTokens, want_cat: l.wantCat,
    owner: l.owner, phone: l.phone, email: l.email, region: l.region,
    pickup_location: l.pickupLocation, cash_ok: l.cashOk, cash_range: l.cashRange,
    status: l.status, owner_account_id: l.ownerAccountId, is_seed: !!l.isSeed,
  };
}
function rowToListing(r) {
  if (!r) return null;
  return {
    id: r.id, cat: r.cat, title: r.title, qty: r.qty, condition: r.condition,
    desc: r.description, price: r.price, specs: r.specs, tags: r.tags,
    wantsText: r.wants_text, wantTokens: r.want_tokens, wantCat: r.want_cat,
    owner: r.owner, phone: r.phone, email: r.email, region: r.region,
    pickupLocation: r.pickup_location, cashOk: r.cash_ok, cashRange: r.cash_range,
    status: r.status, ownerAccountId: r.owner_account_id, isSeed: r.is_seed,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : undefined,
  };
}
function rowToDeal(r) {
  if (!r) return null;
  return {
    id: r.id, initiatorAccountId: r.initiator_account_id, initiatorCompany: r.initiator_company,
    chainListingIds: r.chain_listing_ids,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : undefined,
  };
}

/* ---------------- Accounts ---------------- */
function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}
async function getAccountByEmail(email) {
  const { data, error } = await supabase.from('accounts').select('*').eq('email', normalizeEmail(email)).maybeSingle();
  if (error) throw new Error(`[db] getAccountByEmail failed: ${error.message}`);
  return rowToAccount(data);
}
async function getAccountById(id) {
  if (!id) return null;
  const { data, error } = await supabase.from('accounts').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`[db] getAccountById failed: ${error.message}`);
  return rowToAccount(data);
}
async function upsertAccountVerified(email) {
  const e = normalizeEmail(email);

  // Atomic against two concurrent first-time verifies for the same new
  // email: ON CONFLICT (email) DO NOTHING is enforced by Postgres itself,
  // not a check-then-write in application code, so at most one concurrent
  // caller ever actually inserts. phone/company are deliberately omitted
  // (left to their NULL default) rather than set to null explicitly,
  // since ignoreDuplicates never touches an existing row's columns at
  // all on conflict — there's nothing to accidentally overwrite.
  const { data: inserted, error: insertError } = await supabase.from('accounts')
    .upsert({ id: nanoid(), email: e, verified: true }, { onConflict: 'email', ignoreDuplicates: true })
    .select();
  if (insertError) throw new Error(`[db] upsertAccountVerified insert failed: ${insertError.message}`);
  if (inserted && inserted.length > 0) return rowToAccount(inserted[0]);

  // Email already had an account — every caller in that case (including
  // the loser of the race above, if any) lands here and only ever
  // touches `verified`, never id/phone/company.
  const { data, error } = await supabase.from('accounts').update({ verified: true }).eq('email', e).select().single();
  if (error) throw new Error(`[db] upsertAccountVerified update failed: ${error.message}`);
  return rowToAccount(data);
}
async function updateAccountProfile(id, { company, phone }) {
  const patch = {};
  if (company !== undefined) patch.company = company;
  if (phone !== undefined) patch.phone = phone;
  if (Object.keys(patch).length === 0) return getAccountById(id);

  const { data, error } = await supabase.from('accounts').update(patch).eq('id', id).select().maybeSingle();
  if (error) throw new Error(`[db] updateAccountProfile failed: ${error.message}`);
  return rowToAccount(data);
}

/* ---------------- Verification codes ---------------- */
async function setCode(email, code, ttlMs) {
  const row = { email: normalizeEmail(email), code, expires_at: new Date(Date.now() + ttlMs).toISOString() };
  const { error } = await supabase.from('verification_codes').upsert(row, { onConflict: 'email' });
  if (error) throw new Error(`[db] setCode failed: ${error.message}`);
}
async function checkCode(email, code) {
  const e = normalizeEmail(email);
  const { data, error } = await supabase.from('verification_codes').select('*').eq('email', e).maybeSingle();
  if (error) throw new Error(`[db] checkCode failed: ${error.message}`);
  if (!data) return false;
  if (Date.now() > new Date(data.expires_at).getTime()) return false;
  if (data.code !== String(code).trim()) return false;

  const { error: delError } = await supabase.from('verification_codes').delete().eq('email', e);
  if (delError) throw new Error(`[db] checkCode cleanup failed: ${delError.message}`);
  return true;
}

/* ---------------- Listings (user-published only) ---------------- */
async function allUserListings() {
  const { data, error } = await supabase.from('listings').select('*');
  if (error) throw new Error(`[db] allUserListings failed: ${error.message}`);
  return (data || []).map(rowToListing);
}
async function listingsByOwner(accountId) {
  const { data, error } = await supabase.from('listings').select('*').eq('owner_account_id', accountId);
  if (error) throw new Error(`[db] listingsByOwner failed: ${error.message}`);
  return (data || []).map(rowToListing);
}
async function getListingById(id) {
  const { data, error } = await supabase.from('listings').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`[db] getListingById failed: ${error.message}`);
  return rowToListing(data);
}
async function insertListing(listing) {
  const row = listingToRow(Object.assign({ id: 'u-' + nanoid(), isSeed: false }, listing));
  const { data, error } = await supabase.from('listings').insert(row).select().single();
  if (error) throw new Error(`[db] insertListing failed: ${error.message}`);
  return rowToListing(data);
}
async function updateListingStatus(id, ownerAccountId, status) {
  const { data, error } = await supabase.from('listings')
    .update({ status }).eq('id', id).eq('owner_account_id', ownerAccountId).select().maybeSingle();
  if (error) throw new Error(`[db] updateListingStatus failed: ${error.message}`);
  return rowToListing(data);
}
async function deleteListing(id, ownerAccountId) {
  const { data, error } = await supabase.from('listings')
    .delete().eq('id', id).eq('owner_account_id', ownerAccountId).select();
  if (error) throw new Error(`[db] deleteListing failed: ${error.message}`);
  return !!(data && data.length);
}

/* ---------------- Deals log ---------------- */
async function logDeal(deal) {
  const row = {
    id: nanoid(),
    initiator_account_id: deal.initiatorAccountId,
    initiator_company: deal.initiatorCompany,
    chain_listing_ids: deal.chainListingIds,
  };
  const { data, error } = await supabase.from('deals').insert(row).select().single();
  if (error) throw new Error(`[db] logDeal failed: ${error.message}`);
  return rowToDeal(data);
}

module.exports = {
  normalizeEmail,
  getAccountByEmail, getAccountById, upsertAccountVerified, updateAccountProfile,
  setCode, checkCode,
  allUserListings, listingsByOwner, getListingById, insertListing, updateListingStatus, deleteListing,
  logDeal,
};
