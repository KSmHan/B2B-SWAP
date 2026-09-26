/* =====================================================================
   B2B SWAP — matching engine + seed catalog (server-side, source of truth)
   ===================================================================== */
'use strict';

const CATS = {
  metal:      { label: 'Metal & Raw Materials' },
  wood:       { label: 'Wood & Panels' },
  plastic:    { label: 'Plastics & Polymers' },
  components: { label: 'Components & Parts' },
  packaging:  { label: 'Packaging & Containers' },
};
const CAT_ORDER = ['metal', 'wood', 'plastic', 'components', 'packaging'];

const CAT_KEYWORDS = {
  metal: ['steel','metal','metals','aluminum','aluminium','copper','bronze','titanium','brass','iron','rebar','wire rod','sheet','galvanized','coil','channel bar','round bar','raw material','raw materials'],
  wood: ['wood','wooden','timber','lumber','plywood','mdf','hdf','osb','chipboard','particleboard','hardboard','veneer','board','boards','panel','panels','beam','beams','plank','planks'],
  plastic: ['plastic','plastics','pellet','pellets','resin','pvc','pp','polypropylene','hdpe','ldpe','abs','pet','polymer','polymers','rubber','silicone','polyurethane','epoxy','nylon','foam','fiberglass','polycarbonate','compound'],
  components: ['component','components','part','parts','bearing','bearings','motor','motors','gear','reducer','reducers','cable','valve','valves','cylinder','cylinders','sensor','sensors','contactor','contactors','chain','chains','o-ring','o-rings','terminal','fastener','fasteners','bolt','bolts','drive','drives','vfd'],
  packaging: ['pallet','pallets','box','boxes','bag','bags','film','wrap','crate','crates','drum','drums','tote','totes','ibc','carton','corrugated','strap','strapping','collar','collars','packaging','container','containers'],
};
function detectCategory(tokens) {
  let best = null, bestScore = 0;
  CAT_ORDER.forEach(cat => {
    const kws = CAT_KEYWORDS[cat];
    let s = 0;
    tokens.forEach(t => { if (kws.some(k => k.includes(t) || t.includes(k))) s++; });
    if (s > bestScore) { bestScore = s; best = cat; }
  });
  return best;
}
function nextCatFor(cat, i) {
  const idx = CAT_ORDER.indexOf(cat);
  const jump = (i % 5 === 0) ? 2 : 1;
  return CAT_ORDER[(idx + jump) % CAT_ORDER.length];
}
function tokenize(s) {
  return (s || '').toLowerCase().replace(/[.,"']/g, ' ').split(/\s+/).filter(w => w.length > 2);
}
function normalizeWord(w) { return (w || '').toLowerCase().replace(/[.,"']/g, '').trim(); }

const COMPANIES = ["Titan Alloys Co.","Summit Manufacturing","Meridian Plastics","Vanguard Fasteners","Ironclad Metals","Coastal Packaging","Apex Components","Great Lakes Supply","Redwood Industrial","Anchor Polymers","Union Steelworks","Northstar Molding","Delta Fabrication","Cascade Materials"];
const REGIONS = ["Cleveland, OH","Pittsburgh, PA","Detroit, MI","Houston, TX","Chicago, IL","Milwaukee, WI","Indianapolis, IN","Charlotte, NC","Columbus, OH","Birmingham, AL"];
const CASH_RANGES = ["$0–200","$200–500","$500–1,000","$1,000–2,000"];
const DOCKS = ["Dock A","Dock B","Yard 2","Warehouse 4, Bay 1","Loading Dock 3","Rear Yard Gate 2","Warehouse 1, Bay C","Shipping Dock 5"];
const SPEC_NOTES = {
  metal: 'Mill-certified, standard commercial tolerances. Cert of conformance available on request.',
  wood: 'Stored indoors on pallets. Grade and moisture details available on request.',
  plastic: 'Certificate of analysis available on request. Stored indoors, original packaging.',
  components: 'Original manufacturer packaging, unopened where noted. Datasheets available on request.',
  packaging: 'Stackable and palletized for freight. ISPM-15 compliant where wood is involved.',
};

/* [title, quantity, condition, description, wantsText, wantCat, price] */
const RAW = {
metal: [
 ["Hot-Rolled Steel Sheet, 3mm","5 metric tons","Surplus, unused","Standard hot-rolled sheet, warehouse relocation, never installed","plastic pellets",'plastic',4200],
 ["Stainless Steel 304 Coil","500 kg","Surplus, food-grade","Food-grade coil left over from a cancelled production run","ball bearings",'components',6500],
 ["Aluminum Extrusion Profile 6060","2 metric tons","Surplus, unused","Standard structural profile, excess after façade project","packaging",'packaging',3800],
 ["Copper Wire Rod, 99.9%","800 kg","Surplus, unused","High-purity rod, unused balance from a bulk purchase","polypropylene resin",'plastic',5200],
 ["Rebar A500C, 12mm","10 metric tons","Surplus, construction grade","Excess from a completed construction project","pallets",'packaging',3600],
 ["Galvanized Steel Pipe DN50","300 meters","Surplus, unused","Leftover after a facilities piping upgrade","fasteners",'components',2100],
 ["Bronze Round Bar Stock","400 kg","Surplus, foundry grade","60mm round stock, excess from foundry production","epoxy resin",'plastic',3100],
 ["Titanium Sheet, Grade 5","150 kg","Surplus, aerospace grade","Aerospace-grade sheet, order cancelled after spec change","ball bearings",'components',9800],
 ["Steel Channel Bar, No.16","4 metric tons","Surplus, unused","From a metal service center, excess batch","bulk bags",'packaging',2900],
 ["Brass Rod Stock, 20mm","600 kg","Surplus, unused","Unused balance from a machining order","PET pellets",'plastic',2400],
],
plastic: [
 ["HDPE Resin Pellets","1,000 kg","Surplus, virgin resin","Virgin polymer, leftover from a production batch","steel sheet",'metal',2200],
 ["ABS Plastic Pellets","1,000 kg","Surplus, black, injection grade","Injection-molding grade, excess after a spec change","ball bearings",'components',2300],
 ["Polypropylene Resin, PP","800 kg","Surplus, homopolymer","Unused after a formulation revision","aluminum extrusion",'metal',1800],
 ["PVC Compound, Rigid","600 kg","Surplus, unused","Rigid compound for profile extrusion, excess purchase","pallets",'packaging',1500],
 ["Epoxy Resin, Two-Part","300 kg","Surplus, unused","Two-component system, leftover from production","bronze round bar",'metal',2600],
 ["LDPE Film-Grade Resin","1,200 kg","Surplus, unused","Film-grade resin, excess batch","polypropylene bags",'packaging',2100],
 ["Synthetic Rubber SKI-3","500 kg","Surplus, unused","Leftover from a rubber goods production run","o-rings",'components',1900],
 ["Food-Grade PET Pellets","900 kg","Surplus, food-grade","For bottle production, unused after supplier switch","welding wire",'metal',2000],
 ["Rigid Polyurethane, Two-Part","400 kg","Surplus, unused","For foam production, excess from batch","gear reducers",'components',1700],
 ["Silicone Compound, Heat-Resistant","250 kg","Surplus, unused","Heat-resistant compound, excess purchase","pressure sensors",'components',2400],
 ["Polycarbonate Sheet, 3mm","500 sheets","Surplus, clear","Clear sheet stock, excess after project completion","corrugated board",'packaging',3200],
 ["Fiberglass Roll Stock","400 m²","Surplus, unused","Leftover from a roofing project","copper wire rod",'metal',2800],
 ["Nylon PA6 Pellets","350 kg","Surplus, technical grade","Technical-grade pellets, unused","roller chains",'components',1600],
 ["EPS Foam Blocks","60 m³","Surplus, construction grade","Construction-grade blocks, excess batch","wooden crates",'packaging',1400],
],
components: [
 ["Ball Bearings 6205","500 units","Surplus, new","New, unclaimed batch from a maintenance order","ABS pellets",'plastic',5800],
 ["Fasteners DIN 933, M8","10,000 units","Surplus, zinc-plated","Zinc-plated bolts, excess purchase","cardboard boxes",'packaging',1200],
 ["Induction Motors, 5.5kW","8 units","Surplus, new","New, from a completed capital project","welding wire",'metal',3400],
 ["Worm Gear Reducers","6 units","Surplus, new","Ratio 40:1, unclaimed inventory","polyurethane",'plastic',2800],
 ["Power Cable, 3x2.5mm²","2,000 meters","Surplus, unused","Leftover from a facility rewiring project","shrink film",'packaging',2600],
 ["Hydraulic Cylinders","4 units","Surplus, new","300mm stroke, from a completed project","cast iron blanks",'metal',3100],
 ["Solenoid Pneumatic Valves","40 units","Surplus, 24V, new","New, unclaimed batch","steel drums",'packaging',2200],
 ["Tapered Roller Bearings","300 units","Surplus, new","Unclaimed batch from a bulk order","steel sheet",'metal',2900],
 ["Variable Frequency Drives, 7.5kW","5 units","Surplus, new","New, from a completed automation project","bubble wrap",'packaging',4500],
 ["O-Rings, NBR Rubber","5,000 units","Surplus, unused","Excess from a maintenance purchase","synthetic rubber",'plastic',900],
 ["Roller Chains, 19mm Pitch","50 meters","Surplus, unused","Unclaimed inventory","nylon pellets",'plastic',1500],
 ["Terminal Blocks","2,000 units","Surplus, unused","Leftover from an installation project","pallet collars",'packaging',700],
 ["Industrial Pressure Sensors","60 units","Surplus, new","New, unclaimed inventory","silicone compound",'plastic',3600],
 ["Electromagnetic Contactors","120 units","Surplus, new","Excess from an automation project","strapping tape",'packaging',2500],
],
packaging: [
 ["EUR Wooden Pallets","500 units","Surplus, good condition","Standard 1200x800mm, good reusable condition","rebar",'metal',2500],
 ["Bulk Bags, 1,000kg","300 units","Surplus, new","New, unclaimed order","PVC compound",'plastic',2100],
 ["Cardboard Boxes 40x30x30cm","5,000 units","Surplus, unused","Excess print run, unused","polycarbonate sheet",'plastic',1800],
 ["Stretch Film, 20 micron","200 rolls","Surplus, unused","Unclaimed remainder from a bulk order","galvanized sheet",'metal',1600],
 ["IBC Totes, 1,000L","40 units","Surplus, food-grade, single-use","Food-grade, used once for a single fill","stainless wire",'metal',3200],
 ["Folding Plastic Crates","800 units","Surplus, unused","Unclaimed after a logistics change","aluminum extrusion",'metal',2400],
 ["Polypropylene Bags, 25kg","10,000 units","Surplus, unused","Excess print run","LDPE resin",'plastic',1900],
 ["Shrink Film, Industrial","150 rolls","Surplus, unused","Excess from a bulk purchase","power cable",'components',1300],
 ["Steel Drums, 200L","100 units","Surplus, new","New, unclaimed order","solenoid valves",'components',2600],
 ["Corrugated Board Sheets","3,000 sheets","Surplus, unused","Excess from production","polycarbonate sheet",'plastic',1400],
 ["Bubble Wrap, Industrial","400 rolls","Surplus, unused","Unclaimed remainder","variable frequency drives",'components',1100],
 ["Export Wooden Crates","200 units","Surplus, unused","For oversized freight, excess order","EPS foam",'plastic',2000],
 ["PP Strapping Tape","300 spools","Surplus, unused","Excess purchase","electromagnetic contactors",'components',800],
 ["Cardboard Pallet Collars","1,000 units","Surplus, unused","Unclaimed inventory","terminal blocks",'components',1200],
],
};

function fakePhone(id) {
  const codes = [212, 312, 713, 216, 414];
  const c = codes[id % codes.length];
  const n = String(2000000 + (id * 37) % 7900000).padStart(7, '0');
  return `+1 (${c}) ${n.slice(0, 3)}-${n.slice(3, 7)}`;
}
function fakeEmail(company) {
  return company.toLowerCase().replace(/[^a-z0-9]+/g, '') + '@example-demo.com';
}

/** Builds the fixed seed catalog. These are demo companies with synthetic
 *  contact details — not real, logged-in accounts — so trade confirmations
 *  against them are simulated (clearly labeled as such by the API). */
function buildSeedListings() {
  const items = [];
  let idc = 1;
  Object.keys(RAW).forEach(cat => {
    RAW[cat].forEach((row, i) => {
      const [title, qty, condition, desc, wantsText, wantCat, price] = row;
      const id = 'seed-' + (idc++);
      const cashOk = (i % 3 === 0);
      const owner = COMPANIES[(idc) % COMPANIES.length];
      const region = REGIONS[(idc) % REGIONS.length];
      items.push({
        id, cat, title, qty, condition, desc, price,
        specs: SPEC_NOTES[cat],
        tags: tokenize(title + ' ' + desc + ' ' + condition),
        wantsText, wantTokens: tokenize(wantsText), wantCat,
        owner, region,
        pickupLocation: `${region} — ${DOCKS[idc % DOCKS.length]}`,
        phone: fakePhone(idc),
        email: fakeEmail(owner),
        cashOk, cashRange: cashOk ? CASH_RANGES[i % CASH_RANGES.length] : null,
        status: 'live',
        isSeed: true,
        ownerAccountId: null,
      });
    });
  });
  return items;
}

/* ---------------- Matching engine ---------------- */
const MAX_HOPS = 10;
function score(tokens, itemTokens) {
  let s = 0;
  tokens.forEach(t => { if (itemTokens.some(it => it.includes(t) || t.includes(it))) s++; });
  return s;
}
/** Listings matching what the user has, best first. `words` are the request's
 *  own words and decide the order; `material` (lib/materials.js key named in it,
 *  e.g. "steel") only breaks ties and lets rows of that material qualify even
 *  when no word matches ("алюминий" → "Круг 60" on an aluminum sheet tab). */
/** How many request words appear in the title itself — breaks ties between items
 *  that only match through tags ("White Oak Lumber" → the lumber, not the veneer). */
function titleScore(words, it) {
  const title = String(it.title || '').toLowerCase();
  return words.filter(w => title.includes(w)).length;
}

/** By-products and processed forms. A request that names only the material
 *  ("Walnut") means the material itself — the lumber, not the veneer or the
 *  offcuts — so these lose ties unless the request asks for them. */
const SECONDARY_FORM = /\b(veneers?|scrap|offcuts?|off-cuts?|remnants?|waste|shavings|sawdust|dust|trimmings?|edge\s*banding)\b|шпон|отход|обрез|стружк|опилк|лом(?![а-яё])/i;
function secondaryPenalty(words, it) {
  const m = String(it.title || '').match(SECONDARY_FORM);
  if (!m) return 0;
  const form = m[0].toLowerCase();
  return words.some(w => form.includes(w) || w.includes(form)) ? 0 : 0.05;
}

function findStartCandidates(allItems, words, material) {
  return allItems
    .filter(it => it.status === 'live')
    .map(it => {
      // Same material as requested: an uploaded row of it, or a listing naming it.
      const sameMaterial = material && (it.material === material || (!it.material && score([material], it.tags) > 0));
      const s = score(words, it.tags);
      return { it, s: s + (sameMaterial ? 0.5 : 0) + (s ? titleScore(words, it) * 0.1 - secondaryPenalty(words, it) : 0) };
    })
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map(x => x.it);
}

/**
 * Shortest trade chain from `start` to an item that satisfies `wantTokens`,
 * up to `maxHops` hops. Breadth-first over "the owner of A wants B's
 * category" edges (B.cat === A.wantCat), so a chain is found whenever one
 * exists within the hop limit — the old greedy walk could dead-end early.
 * Among equally short chains the final item that best matches the request
 * wins. With no `need` at all, any item the start's owner wants satisfies it.
 * An item without `wantCat` (uploaded stock: the owner is open to offers)
 * can be followed by any item.
 */
function findChain(allItems, start, wantTokens, maxHops) {
  return findChains(allItems, start, wantTokens, maxHops).path;
}

/**
 * findChain plus every OTHER supplier of the same thing: when several
 * companies offer what was asked for, `alternatives` lists one entry per
 * company ({ item, path }) — `path` is its own shortest chain, or null when no
 * chain reaches it within `maxHops` (the buyer can still contact them).
 * "Same thing" = same category as the best match and a match score close to it.
 */
function findChains(allItems, start, wantTokens, maxHops, maxAlternatives = 20) {
  const wantCatGeneric = detectCategory(wantTokens);
  const hasWant = wantTokens.length > 0;
  const matchScore = (it) => {
    const s = score(wantTokens, it.tags) + (wantCatGeneric && it.cat === wantCatGeneric ? 1 : 0) + titleScore(wantTokens, it) * 0.5;
    return s ? s - secondaryPenalty(wantTokens, it) : 0;
  };
  const startCats = start.wantCats && start.wantCats.length ? start.wantCats : (start.wantCat ? [start.wantCat] : []);
  const satisfied = (it) => (hasWant ? matchScore(it) > 0 : (!startCats.length || startCats.includes(it.cat)));

  const byCat = {};
  allItems.forEach(it => { if (it.status === 'live') (byCat[it.cat] = byCat[it.cat] || []).push(it); });
  const live = allItems.filter(it => it.status === 'live');

  // Breadth-first to the hop limit. Scanning a category (or, for an owner open
  // to offers, everything) claims all its items at once, so each is scanned once.
  const prev = new Map([[start.id, null]]);
  const depth = new Map([[start.id, 0]]);
  const scannedCats = new Set();
  let everythingQueued = false;
  const found = [];
  let frontier = [start];
  for (let hop = 1; hop <= maxHops && frontier.length; hop++) {
    const next = [];
    for (const cur of frontier) {
      let pool;
      const cats = cur.wantCats && cur.wantCats.length ? cur.wantCats : (cur.wantCat ? [cur.wantCat] : []);
      if (cats.length) {
        pool = cats.filter(c => !scannedCats.has(c)).flatMap(c => { scannedCats.add(c); return byCat[c] || []; });
      } else if (!everythingQueued) { pool = live; everythingQueued = true; }
      else pool = [];
      for (const it of pool) {
        if (prev.has(it.id)) continue;
        prev.set(it.id, cur);
        depth.set(it.id, hop);
        next.push(it);
        if (satisfied(it)) found.push(it);
      }
    }
    frontier = next;
  }
  if (!found.length) return { path: null, alternatives: [] };

  const trace = (it) => { const path = []; for (let n = it; n; n = prev.get(n.id)) path.unshift(n); return path; };
  // Shortest chain first; among equally short ones the best-matching item wins.
  // A chain that ends at the company you started from is no trade, so another
  // company's item is preferred whenever one qualifies.
  const others = found.filter(it => !start.owner || it.owner !== start.owner);
  const pool = others.length ? others : found;
  const minDepth = depth.get(pool[0].id);
  let best = pool[0];
  for (const it of pool) if (depth.get(it.id) === minDepth && matchScore(it) > matchScore(best)) best = it;
  const path = trace(best);
  if (!hasWant) return { path, alternatives: [] };

  const bestScore = matchScore(best);
  const perOwner = new Map();
  for (const it of live) {
    if (!it.owner || it.owner === best.owner || it === start) continue;
    if (it.cat !== best.cat || matchScore(it) < bestScore * 0.75) continue;
    const d = depth.has(it.id) ? depth.get(it.id) : Infinity;
    const cur = perOwner.get(it.owner);
    if (!cur || d < cur.d || (d === cur.d && matchScore(it) > matchScore(cur.it))) perOwner.set(it.owner, { it, d });
  }
  const alternatives = [...perOwner.values()]
    .sort((a, b) => a.d - b.d || matchScore(b.it) - matchScore(a.it))
    .slice(0, maxAlternatives)
    .map(({ it, d }) => ({ item: it, path: d === Infinity ? null : trace(it) }));
  return { path, alternatives };
}
function suggestSimilar(allItems, tokens) {
  return allItems
    .filter(it => it.status === 'live')
    .map(it => ({ it, s: score(tokens, it.tags) }))
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 2).map(x => x.it);
}

module.exports = {
  CATS, CAT_ORDER, CASH_RANGES, DOCKS, SPEC_NOTES,
  detectCategory, nextCatFor, tokenize, normalizeWord,
  buildSeedListings, MAX_HOPS,
  score, findStartCandidates, findChain, findChains, suggestSimilar,
};
