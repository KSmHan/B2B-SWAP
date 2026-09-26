/* =====================================================================
   B2B SWAP — uploaded stock-list items as regular listings.

   Every row of every live stock card (see routes/cards.js) is exposed to
   the catalog, the "I have / I need" chain search and deal confirmation
   in the same shape as a hand-published listing, so all of them treat the
   two kinds of stock the same way.
   ===================================================================== */
'use strict';

const M = require('../matching');
const { classify, materialLabel } = require('./materials');

// Material type (lib/materials.js) → catalog / matching category (matching.js CATS).
const MATERIAL_TO_CAT = {
  stainless: 'metal', galvanized: 'metal', aluminum: 'metal', copper: 'metal', brass: 'metal',
  bronze: 'metal', titanium: 'metal', cast_iron: 'metal', steel: 'metal', metal_other: 'metal',
  mdf: 'wood', hdf: 'wood', plywood: 'wood', chipboard: 'wood', osb: 'wood', lumber: 'wood',
  plastic: 'plastic', rubber: 'plastic',
  packaging: 'packaging',
  components: 'components', cable: 'components', glass: 'components', other: 'components',
};

function catForMaterial(key) { return MATERIAL_TO_CAT[key] || 'components'; }

/** Dollar amount from a free-text price ("$4.10/kg", "$780") — null for other currencies or none. */
function dollarPrice(text) {
  const t = String(text || '');
  if (!/\$|usd/i.test(t)) return null;
  const m = t.replace(/,/g, '').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function hashIndex(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** One stock item (with its card) → listing shape used by /api/listings and the agent. */
function stockItemToListing(item) {
  const card = item.card || {};
  const cat = catForMaterial(item.category);
  const label = materialLabel(item.category);
  const qty = item.qty ? `${item.qty}${item.unit ? ' ' + item.unit : ''}` : '';
  const text = `${item.title} ${item.specs || ''} ${label}`;
  const tags = [...new Set([
    ...M.tokenize(text),
    item.category,
    cat,
    ...label.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2),
  ])];
  return {
    id: `s-${item.id}`,
    cat,
    material: item.category,
    materialLabel: label,
    title: item.title,
    qty,
    condition: label,
    desc: item.specs || '',
    price: dollarPrice(item.price),
    priceText: item.price || '',
    specs: item.specs || label,
    tags,
    wantsText: 'open to offers',
    wantTokens: [],
    // Uploaders don't say what they want in return, so — like a published
    // listing that is "open to offers" — they point at a neighbouring category.
    wantCat: M.nextCatFor(cat, hashIndex(item.id)),
    owner: card.company,
    phone: card.phone,
    email: card.email,
    contactName: card.contactName,
    region: '—',
    pickupLocation: '',
    cashOk: false,
    cashRange: null,
    status: 'live',
    isSeed: false,
    isStock: true,
    cardId: card.id,
    ownerAccountId: null,
  };
}

/** Adds the material type named in free text (any language) as an extra search token. */
function withMaterialToken(text, tokens) {
  const key = classify(text);
  return key && !tokens.includes(key) ? [...tokens, key] : tokens;
}

module.exports = { stockItemToListing, catForMaterial, dollarPrice, withMaterialToken, MATERIAL_TO_CAT };
