'use strict';
// "I have / I need" search over uploaded stock-list rows + published listings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const M = require('../matching');
const { parseStockFile } = require('../lib/stock-parser');
const { stockItemToListing, withMaterialToken, dollarPrice } = require('../lib/stock-listings');

function listing(id, cat, wantCat, title) {
  return { id, cat, wantCat, title, tags: M.tokenize(title), status: 'live' };
}

test('finds a chain of exactly 10 hops (and not 11)', () => {
  // A ring of categories where each owner wants the next one; "target" sits 10 hops out.
  const cats = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11'];
  const items = cats.map((c, i) => listing(`n${i}`, c, cats[i + 1] || 'none', i === 10 ? 'rare target widget' : `filler item ${i}`));
  const found = M.findChain(items, items[0], ['target'], M.MAX_HOPS);
  assert.equal(M.MAX_HOPS, 10);
  assert.equal(found.length, 11);
  assert.equal(found.at(-1).id, 'n10');

  const farther = items.map(it => (it.id === 'n10' ? Object.assign({}, it, { title: 'filler', tags: ['filler'] }) : it));
  farther[11] = Object.assign({}, farther[11], { tags: ['target'] }); // 11 hops away
  assert.equal(M.findChain(farther, farther[0], ['target'], M.MAX_HOPS), null);
});

test('breadth-first: a dead end on the greedy path no longer hides a real chain', () => {
  const items = [
    listing('start', 'metal', 'plastic', 'steel sheet'),
    // Scores best for "pallets" by name but its owner wants a category nobody has.
    listing('trap', 'plastic', 'nothing', 'pallets pellets'),
    listing('p2', 'plastic', 'packaging', 'hdpe pellets'),
    listing('goal', 'packaging', 'metal', 'eur pallets'),
  ];
  const found = M.findChain(items, items[0], ['pallets'], M.MAX_HOPS);
  assert.deepEqual(found.map(i => i.id), ['start', 'trap']); // 1 hop: "trap" itself matches
  const strict = M.findChain(items, items[0], ['eur'], M.MAX_HOPS);
  assert.deepEqual(strict.map(i => i.id), ['start', 'p2', 'goal']);
});

test('uploaded stock rows become searchable listings', async () => {
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'stock-ru.xlsx'));
  const { items } = await parseStockFile(buf, 'stock-ru.xlsx');
  const card = { id: 'card1', company: 'Metal-Drev', phone: '+7 900', email: 'a@b.co', contactName: 'Ivan' };
  const listings = items.map((it, i) => stockItemToListing(Object.assign({ id: i + 1, card }, it)));

  const alu = listings[0];
  assert.equal(alu.title, 'Лист алюминиевый');
  assert.equal(alu.cat, 'metal');
  assert.equal(alu.material, 'aluminum');
  assert.equal(alu.qty, '150 кг');
  assert.equal(alu.priceText, '380');
  assert.equal(alu.price, null); // not dollars → not placed in $ price bands
  assert.ok(alu.tags.includes('aluminum') && alu.tags.includes('metal'));
  assert.equal(alu.isStock, true);
  assert.equal(alu.cardId, 'card1');
  assert.equal(alu.wantCat, null); // uploader is open to offers
  assert.equal(listings.find(l => l.material === 'plywood').cat, 'wood');
  assert.equal(dollarPrice('$4.10/kg'), 4.1);
  assert.equal(dollarPrice('$1,200'), 1200);
});

test('Russian or English "I have / I need" text reaches uploaded rows', async () => {
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'stock-ru.xlsx'));
  const { items } = await parseStockFile(buf, 'stock-ru.xlsx');
  const card = { id: 'c', company: 'X', phone: '1', email: 'x@y.z' };
  const stock = items.map((it, i) => stockItemToListing(Object.assign({ id: i + 1, card }, it)));
  const all = stock.concat([
    listing('pub-1', 'plastic', 'wood', 'HDPE resin pellets'),
    listing('pub-2', 'packaging', 'metal', 'EUR wooden pallets'),
  ]);

  // "I have: алюминий" finds the aluminum rows by material type, not by exact word.
  const starts = M.findStartCandidates(all, M.tokenize('алюминий'), 'aluminum');
  assert.ok(starts.length && starts[0].material === 'aluminum');

  // "I need: фанера" (plywood) — a chain ends on an uploaded plywood row.
  const need = withMaterialToken('фанера', M.tokenize('фанера'));
  const chain = M.findChain(all, starts[0], need, M.MAX_HOPS);
  assert.ok(chain && chain.length >= 2 && chain.length <= 11);
  assert.equal(chain.at(-1).material, 'plywood');
  // Every hop follows what the previous owner wants (or anything, if open to offers).
  for (let i = 1; i < chain.length; i++) assert.ok(!chain[i - 1].wantCat || chain[i].cat === chain[i - 1].wantCat);

  // English works the same way.
  const en = M.findChain(all, M.findStartCandidates(all, ['copper'], 'copper')[0], withMaterialToken('MDF board', M.tokenize('MDF board')), M.MAX_HOPS);
  assert.equal(en.at(-1).material, 'mdf');
});

test('the material named in "I have" outranks look-alike words', async () => {
  const card = { id: 'c', company: 'X', phone: '1', email: 'x@y.z' };
  const rows = [
    { id: 1, category: 'plastic', title: 'Polycarbonate sheet 3mm', card },
    { id: 2, category: 'steel', title: 'Hot-rolled steel plate', card },
  ].map(stockItemToListing);
  assert.equal(M.findStartCandidates(rows, M.tokenize('steel sheet'), 'steel')[0].title, 'Hot-rolled steel plate');
});

test('a word match beats a same-material look-alike ("HDPE" starts from HDPE, not polycarbonate)', () => {
  const card = { id: 'c', company: 'X', phone: '1', email: 'x@y.z' };
  const rows = [
    stockItemToListing({ id: 1, category: 'plastic', title: 'Polycarbonate sheet 3mm', card }),
    { id: 'pub', cat: 'plastic', wantCat: 'wood', title: 'HDPE resin pellets', tags: M.tokenize('HDPE resin pellets'), status: 'live' },
  ];
  assert.equal(M.findStartCandidates(rows, M.tokenize('HDPE'), 'plastic')[0].title, 'HDPE resin pellets');
});

test('one supplier\'s uploaded list: "Walnut" → "White Oak Lumber" is found (open to offers)', () => {
  const card = { id: 'tital', company: 'Tital', phone: '1', email: 't@t.co', contactName: 'Ann' };
  const rows = [
    { id: 3, category: 'lumber', title: 'White Oak Veneer', qty: '122', price: '$24.00' }, // listed first on purpose
    { id: 1, category: 'lumber', title: 'Walnut Lumber 4/4', qty: '900', price: '$9.10' },
    { id: 2, category: 'lumber', title: 'White Oak Lumber 4/4', qty: '1,850', price: '$6.10' },
    { id: 4, category: 'plywood', title: 'Maple Plywood 3/4 in', qty: '40' },
  ].map(r => stockItemToListing(Object.assign({ card }, r)));
  // Published listings whose owners want metal — the old rotation dead-ended here.
  const pub = [{ id: 'p1', cat: 'metal', wantCat: 'metal', title: 'Test Steel Sheet', tags: ['test', 'steel', 'sheet'], status: 'live' }];
  const all = rows.concat(pub);

  const start = M.findStartCandidates(all, M.tokenize('Walnut'), null)[0];
  assert.equal(start.title, 'Walnut Lumber 4/4');
  const chain = M.findChain(all, start, M.tokenize('White Oak Lumber'), M.MAX_HOPS);
  assert.ok(chain, 'a chain must be found');
  assert.deepEqual(chain.map(c => c.title), ['Walnut Lumber 4/4', 'White Oak Lumber 4/4']); // not the veneer
});

test('open-to-offers nodes are expanded once, so large catalogs stay fast', () => {
  const card = { id: 'c', company: 'C', phone: '1', email: 'c@c.co' };
  const rows = [];
  for (let i = 0; i < 20000; i++) rows.push(stockItemToListing({ id: i, category: 'steel', title: `Steel item ${i}`, card }));
  rows.push(stockItemToListing({ id: 'x', category: 'copper', title: 'Rare copper busbar', card }));
  const t = Date.now();
  const chain = M.findChain(rows, rows[0], ['busbar'], M.MAX_HOPS);
  assert.equal(chain.at(-1).title, 'Rare copper busbar');
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
});

test('"What do you need in return?" steers the chain', () => {
  const { wantsFields } = require('../lib/stock-listings');
  assert.deepEqual(wantsFields('plywood, packaging').wantCats, ['wood', 'packaging']);
  assert.deepEqual(wantsFields('фанера или поддоны').wantCats, ['wood', 'packaging']);
  assert.deepEqual(wantsFields('').wantCats, []);

  const mk = (id, category, title, company, wants) => stockItemToListing({ id, category, title, card: { id: company, company, phone: '1', email: company + '@x.co', wants } });
  const rows = [
    mk(1, 'steel', 'Steel plate 10mm', 'SteelCo', 'plywood'),        // SteelCo only wants wood
    mk(2, 'plywood', 'Birch plywood 18mm', 'WoodCo', 'copper'),      // WoodCo wants copper
    mk(3, 'copper', 'Copper busbar', 'CuCo', ''),                    // CuCo open to offers
    mk(4, 'plastic', 'HDPE pellets', 'PlastCo', ''),
  ];
  assert.equal(rows[0].wantsText, 'plywood');
  assert.equal(rows[0].wantCat, 'wood');
  // SteelCo can't jump straight to plastics: it only takes wood, so the chain goes through WoodCo → CuCo.
  const chain = M.findChain(rows, rows[0], M.tokenize('HDPE pellets'), M.MAX_HOPS);
  assert.deepEqual(chain.map(c => c.title), ['Steel plate 10mm', 'Birch plywood 18mm', 'Copper busbar', 'HDPE pellets']);
});

test('several suppliers of the same material are all returned', () => {
  const pub = (id, owner, cat, wantCat, title) => Object.assign(listing(id, cat, wantCat, title), { owner });
  const all = [
    pub('start', 'SteelCo', 'metal', 'wood', 'steel sheet'),
    pub('a1', 'Oak Mill', 'wood', 'metal', 'White Oak Lumber 4/4'),
    pub('a2', 'Oak Mill', 'wood', 'metal', 'White Oak Lumber 8/4'), // same company: listed once
    pub('b1', 'Forest Co', 'wood', 'plastic', 'White oak lumber, kiln dried'),
    pub('c1', 'Veneer Ltd', 'wood', 'metal', 'Walnut veneer'), // other wood, not what was asked
    pub('d1', 'Plastics Inc', 'plastic', 'metal', 'white HDPE sheet'), // other category
  ];
  const { path, alternatives } = M.findChains(all, all[0], M.tokenize('White Oak Lumber'), M.MAX_HOPS);
  assert.deepEqual(path.map(p => p.id), ['start', 'a1']);
  assert.deepEqual(alternatives.map(a => a.item.owner), ['Forest Co']);
  assert.deepEqual(alternatives[0].path.map(p => p.id), ['start', 'b1']);
  // findChain keeps returning just the best chain.
  assert.deepEqual(M.findChain(all, all[0], M.tokenize('White Oak Lumber'), M.MAX_HOPS).map(p => p.id), ['start', 'a1']);
});

test('a request naming only the material prefers the material over veneer / scrap', () => {
  const L = (id, title) => ({ id, title, owner: 'Tital', cat: 'wood', tags: M.tokenize(title), status: 'live' });
  const all = [L('v', 'Walnut Veneer'), L('s', 'Walnut scrap'), L('l', 'Walnut Lumber 4/4')];
  assert.equal(M.findStartCandidates(all, M.tokenize('Walnut'), null)[0].title, 'Walnut Lumber 4/4');
  assert.equal(M.findStartCandidates(all, M.tokenize('walnut veneer'), null)[0].title, 'Walnut Veneer');
  // Same on the "I need" side.
  const start = { id: 'st', title: 'Steel sheet', owner: 'SteelCo', cat: 'metal', wantCat: 'wood', tags: ['steel', 'sheet'], status: 'live' };
  assert.equal(M.findChain([start, ...all], start, M.tokenize('Walnut'), M.MAX_HOPS).at(-1).title, 'Walnut Lumber 4/4');
});
