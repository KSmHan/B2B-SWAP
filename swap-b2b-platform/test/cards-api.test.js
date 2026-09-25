'use strict';
// End-to-end over HTTP: the real Express router with the in-memory store.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
require('express-async-errors');
const { createCardsRouter } = require('../routes/cards');
const { createMemoryStore } = require('../lib/cards-store');

const sent = [];
let base, server;

test.before(async () => {
  const app = express();
  const mailer = { sendMail: async (m) => { sent.push(m); return { sent: true }; } };
  app.use('/api/cards', createCardsRouter({ store: createMemoryStore(), mailer, uploadLimit: (req, res, next) => next() }));
  app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'internal_error' }); });
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cards`;
});
test.after(() => server.close());

function form(fields, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append('file', new Blob([file.data]), file.name);
  return fd;
}
const CONTACT = { company: 'ООО Металл-Древ', contactName: 'Иван Петров', email: 'Ivan@Example.com', phone: '+7 900 000-00-00' };
const fixture = (name) => ({ name, data: fs.readFileSync(path.join(__dirname, 'fixtures', name)) });
async function post(fields, file) {
  const res = await fetch(base, { method: 'POST', body: form(fields, file) });
  return { status: res.status, body: await res.json() };
}

for (const f of ['stock-ru.xlsx', 'stock-ru.xls', 'stock-ru-utf8.csv', 'stock-ru-cp1251.csv', 'stock-ru.docx', 'stock-ru.doc', 'stock-ru.pdf', 'stock-ru-from-excel.pdf']) {
  test(`upload ${f} creates a catalogued card`, async () => {
    const { status, body } = await post(CONTACT, fixture(f));
    assert.equal(status, 201, JSON.stringify(body));
    assert.ok(body.card.itemCount >= 11);
    for (const k of ['aluminum', 'copper', 'steel', 'stainless', 'mdf', 'plywood', 'chipboard', 'osb']) assert.ok(body.card.categories[k] > 0, k);
    assert.equal(body.card.email, 'ivan@example.com');
    assert.equal(body.card.manageTokenHash, undefined, 'token hash must never be exposed');
    assert.match(body.manageUrl, /card\.html\?id=[a-z0-9]{12}&key=/);
  });
}

test('card page data, catalogue filters, search and original file download', async () => {
  const { body } = await post(Object.assign({}, CONTACT, { company: 'Acme Surplus' }), fixture('stock-en.csv'));
  const id = body.card.id;

  const card = await (await fetch(`${base}/${id}`)).json();
  assert.equal(card.card.company, 'Acme Surplus');
  assert.equal(card.card.contactName, 'Иван Петров');
  assert.equal(card.card.hasFile, true);
  assert.equal(card.items.length, 6);

  const mdf = await (await fetch(`${base}/items?cat=mdf`)).json();
  assert.ok(mdf.items.length >= 1 && mdf.items.every(i => i.category === 'mdf'));
  assert.ok(mdf.items[0].card.company && mdf.items[0].card.phone);

  const search = await (await fetch(`${base}/items?q=${encodeURIComponent('birch plywood')}`)).json();
  // Earlier Excel uploads in this store also carry "Birch plywood 18mm".
  assert.ok(search.total >= 1);
  assert.ok(search.items.every(i => /birch plywood/i.test(i.title)));
  assert.ok(search.items.some(i => i.card.id === id));

  const mats = await (await fetch(`${base}/materials`)).json();
  assert.ok(mats.materials.find(m => m.key === 'aluminum').count >= 9);

  const file = await fetch(`${base}/${id}/file`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /stock-en\.csv/);
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), fixture('stock-en.csv').data.toString());

  const list = await (await fetch(base)).json();
  assert.equal(list.cards[0].id, id);
  assert.ok(sent.some(m => m.to === 'ivan@example.com' && m.text.includes(id)));
});

test('owner can fix a material and remove the card; others cannot', async () => {
  const { body } = await post(CONTACT, fixture('stock-en.csv'));
  const id = body.card.id;
  const item = (await (await fetch(`${base}/${id}`)).json()).items[0];
  const patch = (key, category) => fetch(`${base}/${id}/items/${item.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Manage-Key': key }, body: JSON.stringify({ category }),
  });

  assert.equal((await patch('wrong-key', 'copper')).status, 403);
  assert.equal((await patch(body.manageKey, 'not-a-material')).status, 400);
  assert.equal((await patch(body.manageKey, 'copper')).status, 200);
  const after = await (await fetch(`${base}/${id}`)).json();
  assert.equal(after.items[0].category, 'copper');
  assert.equal(after.card.categories.copper, 2);

  assert.equal((await fetch(`${base}/${id}`, { method: 'DELETE', headers: { 'X-Manage-Key': 'nope' } })).status, 403);
  assert.equal((await fetch(`${base}/${id}`, { method: 'DELETE', headers: { 'X-Manage-Key': body.manageKey } })).status, 200);
  assert.equal((await fetch(`${base}/${id}`)).status, 404);
});

test('validation: every field required, one clear message each', async () => {
  const { status, body } = await post({ company: '', contactName: '', email: 'nope', phone: '12' });
  assert.equal(status, 400);
  assert.deepEqual(Object.keys(body.fields).sort(), ['company', 'contactName', 'email', 'file', 'phone']);
});

test('rejects unsupported, corrupt, empty-of-stock and oversized files', async () => {
  let r = await post(CONTACT, { name: 'photo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'unsupported_type');

  r = await post(CONTACT, { name: 'list.xlsx', data: Buffer.from('not really excel') });
  assert.equal(r.status, 422); assert.equal(r.body.error, 'corrupt_file');

  r = await post(CONTACT, { name: 'notes.csv', data: Buffer.from('hello\nworld') });
  assert.equal(r.status, 422); assert.equal(r.body.error, 'no_items');

  r = await post(CONTACT, { name: 'big.csv', data: Buffer.alloc(5 * 1024 * 1024, 'a') });
  assert.equal(r.status, 413); assert.equal(r.body.error, 'file_too_large');
});

test('honeypot field silently blocks bots', async () => {
  const r = await post(Object.assign({ website: 'http://spam' }, CONTACT), fixture('stock-en.csv'));
  assert.equal(r.status, 400);
});

test('unknown card → 404', async () => {
  assert.equal((await fetch(`${base}/doesnotexist`)).status, 404);
});
