'use strict';

const express = require('express');
const db = require('../db');
const mailer = require('../mailer');
const sms = require('../sms');
const { requireVerifiedProfile } = require('../auth-mw');
const { allListings } = require('./listings');

const router = express.Router();

async function notifyParticipant({ listing, initiatorCompany, isInitiator }) {
  const results = [];

  // Email — real for anyone with an email on file (both the initiator and
  // any other REAL registered account in the chain). Seed/demo companies
  // have synthetic emails, so those sends are logged rather than delivered.
  if (listing.email) {
    const subject = isInitiator
      ? `B2B SWAP — your trade interest is confirmed`
      : `B2B SWAP — ${initiatorCompany} confirmed interest in a trade with you`;
    const text = isInitiator
      ? `You confirmed interest in a trade involving "${listing.title}". We've notified every other company in the chain by email and SMS.`
      : `${initiatorCompany} has confirmed interest in a trade chain that includes your listing "${listing.title}". Log in to B2B SWAP to review and respond.`;
    const mailResult = listing.isSeed
      ? { sent: false, reason: 'demo_company' }
      : await mailer.sendMail({ to: listing.email, subject, text });
    results.push({ channel: 'email', to: listing.email, ...mailResult });
  }

  // SMS — same logic: only real, registered phone numbers actually get texted.
  if (listing.phone) {
    const body = isInitiator
      ? `B2B SWAP: your interest in a trade involving "${listing.title}" is confirmed.`
      : `B2B SWAP: ${initiatorCompany} confirmed interest in a trade involving your "${listing.title}". Log in to respond.`;
    const smsResult = listing.isSeed
      ? { sent: false, reason: 'demo_company' }
      : await sms.sendSms({ to: listing.phone, body });
    results.push({ channel: 'sms', to: listing.phone, ...smsResult });
  }

  return results;
}

// POST /api/deals/confirm { listingIds: [...] }  (the full chain, in order)
router.post('/confirm', requireVerifiedProfile, async (req, res) => {
  const ids = Array.isArray(req.body.listingIds) ? req.body.listingIds : [];
  if (ids.length === 0) return res.status(400).json({ error: 'missing_listing_ids' });

  const items = await allListings();
  const chain = ids.map(id => items.find(it => it.id === id)).filter(Boolean);
  if (chain.length === 0) return res.status(404).json({ error: 'chain_not_found' });

  const initiatorCompany = req.account.company;
  const notifications = [];

  for (let i = 0; i < chain.length; i++) {
    const listing = chain[i];
    const isInitiatorListing = listing.ownerAccountId === req.account.id;
    const results = await notifyParticipant({ listing, initiatorCompany, isInitiator: isInitiatorListing || i === 0 });
    notifications.push({ listingId: listing.id, title: listing.title, owner: listing.owner, results });
  }

  await db.logDeal({
    initiatorAccountId: req.account.id,
    initiatorCompany,
    chainListingIds: ids,
  });

  res.json({ ok: true, notifications });
});

module.exports = router;
