/* =====================================================================
   B2B SWAP — persistence layer

   This is a small file-backed JSON store. It is real, server-side,
   shared storage — unlike the previous browser-localStorage prototype,
   every account and listing here lives on the server and is visible
   from any device, for any user, the moment it's created.

   For a small-to-mid size deployment this is sufficient (writes are
   synchronous and queued, so concurrent requests can't corrupt the
   file). For higher traffic, swap this module for Postgres/MySQL —
   every other file only talks to the functions exported here, so the
   rest of the app does not need to change.
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { customAlphabet } = require('nanoid');

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

function emptyState() {
  return {
    accounts: [],       // { id, phone, email, company, verified, createdAt }
    codes: {},          // phone -> { code, expiresAt }
    listings: [],        // user-published listings (seed listings live in matching.js, not here)
    deals: [],           // log of confirmed-interest events
  };
}

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(emptyState(), null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('[db] failed to read data file, starting fresh:', e.message);
    return emptyState();
  }
}

let state = load();
let writeQueued = false;
function persist() {
  if (writeQueued) return;
  writeQueued = true;
  setImmediate(() => {
    writeQueued = false;
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  });
}

/* ---------------- Accounts ---------------- */
function normalizePhone(phone) {
  return (phone || '').replace(/[^\d+]/g, '');
}
function getAccountByPhone(phone) {
  const p = normalizePhone(phone);
  return state.accounts.find(a => normalizePhone(a.phone) === p) || null;
}
function getAccountById(id) {
  return state.accounts.find(a => a.id === id) || null;
}
function upsertAccountVerified(phone) {
  let acc = getAccountByPhone(phone);
  if (!acc) {
    acc = { id: nanoid(), phone, email: null, company: null, verified: true, createdAt: Date.now() };
    state.accounts.push(acc);
  } else {
    acc.verified = true;
  }
  persist();
  return acc;
}
function updateAccountProfile(id, { company, email }) {
  const acc = getAccountById(id);
  if (!acc) return null;
  if (company !== undefined) acc.company = company;
  if (email !== undefined) acc.email = email;
  persist();
  return acc;
}

/* ---------------- Verification codes ---------------- */
function setCode(phone, code, ttlMs) {
  state.codes[normalizePhone(phone)] = { code, expiresAt: Date.now() + ttlMs };
  persist();
}
function checkCode(phone, code) {
  const entry = state.codes[normalizePhone(phone)];
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) return false;
  if (entry.code !== String(code).trim()) return false;
  delete state.codes[normalizePhone(phone)];
  persist();
  return true;
}

/* ---------------- Listings (user-published only) ---------------- */
function allUserListings() {
  return state.listings;
}
function listingsByOwner(accountId) {
  return state.listings.filter(l => l.ownerAccountId === accountId);
}
function getListingById(id) {
  return state.listings.find(l => l.id === id) || null;
}
function insertListing(listing) {
  const row = Object.assign({ id: 'u-' + nanoid(), createdAt: Date.now(), isSeed: false }, listing);
  state.listings.push(row);
  persist();
  return row;
}
function updateListingStatus(id, ownerAccountId, status) {
  const l = getListingById(id);
  if (!l || l.ownerAccountId !== ownerAccountId) return null;
  l.status = status;
  persist();
  return l;
}
function deleteListing(id, ownerAccountId) {
  const idx = state.listings.findIndex(l => l.id === id && l.ownerAccountId === ownerAccountId);
  if (idx === -1) return false;
  state.listings.splice(idx, 1);
  persist();
  return true;
}

/* ---------------- Deals log ---------------- */
function logDeal(deal) {
  const row = Object.assign({ id: nanoid(), createdAt: Date.now() }, deal);
  state.deals.push(row);
  persist();
  return row;
}

module.exports = {
  normalizePhone,
  getAccountByPhone, getAccountById, upsertAccountVerified, updateAccountProfile,
  setCode, checkCode,
  allUserListings, listingsByOwner, getListingById, insertListing, updateListingStatus, deleteListing,
  logDeal,
};
