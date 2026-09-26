'use strict';

const express = require('express');
const M = require('../matching');
const { allListings, publicListing } = require('./listings');
const { withMaterialToken } = require('../lib/stock-listings');
const { classify } = require('../lib/materials');

const router = express.Router();

// POST /api/agent/search { have, need }
router.post('/search', async (req, res) => {
  const have = (req.body.have || '').trim();
  const need = (req.body.need || '').trim();
  // The material type named in either field (English or Russian, incl. grade
  // codes like АМг3 / 6061) is matched against uploaded stock-list rows too.
  const haveTokens = withMaterialToken(have, M.tokenize(have));
  const wantTokens = withMaterialToken(need, M.tokenize(need));

  if (haveTokens.length === 0) {
    return res.json({ status: 'need_more_detail', message: 'Tell the agent what you have — a few words is enough.' });
  }

  const items = await allListings();
  const candidates = M.findStartCandidates(items, haveTokens, classify(have));
  if (candidates.length === 0) {
    const alt = M.suggestSimilar(items, wantTokens.length ? wantTokens : haveTokens);
    return res.json({
      status: 'no_start_match',
      message: 'Nothing close to that in current listings.',
      suggestions: alt.map(publicListing),
    });
  }

  const start = candidates[0];
  const path = M.findChain(items, start, wantTokens, M.MAX_HOPS);
  if (!path) {
    const alt = M.suggestSimilar(items, wantTokens);
    return res.json({
      status: 'no_chain',
      message: `No chain found even through ${M.MAX_HOPS} hops.`,
      suggestions: alt.map(publicListing),
    });
  }

  res.json({
    status: 'ok',
    hops: path.length - 1,
    chain: path.map(publicListing),
  });
});

module.exports = router;
