'use strict';

const express = require('express');
const db = require('../db');
const M = require('../matching');
const { requireVerifiedProfile } = require('../auth-mw');

const router = express.Router();

const SEED = M.buildSeedListings();

async function allListings() {
  return [...SEED, ...(await db.allUserListings())];
}

function publicListing(l) {
  // Public catalog view never exposes an account's raw email — only what's
  // needed to make contact and to identify the pickup point.
  const { email, ownerAccountId, ...rest } = l;
  return rest;
}

// GET /api/listings?search=&cat=&price=&cash=
router.get('/', async (req, res) => {
  const { search = '', cat = '', price = '', cash = '' } = req.query;
  const q = M.normalizeWord(search);
  let list = (await allListings()).filter(it => it.status === 'live');
  if (cat) list = list.filter(it => it.cat === cat);
  if (cash === '1') list = list.filter(it => it.cashOk);
  if (price) {
    const [lo, hi] = price.split('-').map(Number);
    list = list.filter(it => it.price >= lo && it.price <= hi);
  }
  if (q) {
    list = list.filter(it => (it.title + ' ' + it.desc + ' ' + it.wantsText + ' ' + (it.condition || '')).toLowerCase().includes(q));
  }
  res.json({ count: list.length, listings: list.map(publicListing) });
});

// GET /api/listings/mine  (requires full, verified account)
router.get('/mine', requireVerifiedProfile, async (req, res) => {
  const mine = await db.listingsByOwner(req.account.id);
  res.json({ listings: mine });
});

// POST /api/listings  (requires full, verified account)
router.post('/', requireVerifiedProfile, async (req, res) => {
  const b = req.body || {};
  const title = (b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'missing_title' });
  const cat = M.CAT_ORDER.includes(b.cat) ? b.cat : 'metal';
  const wantsText = (b.wantsText || '').trim() || 'open to offers';
  const wantTokens = M.tokenize(wantsText);
  const existingCount = (await db.listingsByOwner(req.account.id)).length;
  const wantCat = M.detectCategory(wantTokens) || M.nextCatFor(cat, existingCount);
  const qty = (b.qty || '').trim();
  const condition = (b.condition || 'Surplus').trim();
  const desc = (b.desc || '').trim();
  const region = (b.region || '—').trim();
  const pickupLocation = (b.pickupLocation || region).trim();
  const price = Number(b.price) || 0;
  const cashOk = !!b.cashOk;
  const cashRange = cashOk ? (b.cashRange || M.CASH_RANGES[0]) : null;

  const listing = await db.insertListing({
    cat, title, qty, condition, desc, price,
    specs: M.SPEC_NOTES[cat],
    tags: M.tokenize(title + ' ' + desc + ' ' + condition),
    wantsText, wantTokens, wantCat,
    owner: req.account.company,
    phone: req.account.phone,
    email: req.account.email,
    region, pickupLocation,
    cashOk, cashRange,
    status: 'live',
    ownerAccountId: req.account.id,
  });
  res.status(201).json({ listing });
});

// PATCH /api/listings/:id/status  { status: 'live'|'chain'|'done' }
router.patch('/:id/status', requireVerifiedProfile, async (req, res) => {
  const status = req.body.status;
  if (!['live', 'chain', 'done'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
  const l = await db.updateListingStatus(req.params.id, req.account.id, status);
  if (!l) return res.status(404).json({ error: 'not_found_or_not_owner' });
  res.json({ listing: l });
});

// DELETE /api/listings/:id
router.delete('/:id', requireVerifiedProfile, async (req, res) => {
  const ok = await db.deleteListing(req.params.id, req.account.id);
  if (!ok) return res.status(404).json({ error: 'not_found_or_not_owner' });
  res.json({ ok: true });
});

module.exports = { router, allListings, publicListing, SEED };
