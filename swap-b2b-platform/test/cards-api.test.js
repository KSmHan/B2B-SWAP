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

test('owner adds a second file (append) and replaces the list; each file stays downloadable', async () => {
  const { body } = await post(Object.assign({}, CONTACT, { company: 'Multi File Co' }), fixture('stock-en.csv'));
  const id = body.card.id;
  const upload = (key, file, mode) => {
    const fd = form(mode ? { mode } : {}, file);
    return fetch(`${base}/${id}/files`, { method: 'POST', headers: { 'X-Manage-Key': key }, body: fd });
  };

  // Wrong key: rejected before the file is even read.
  assert.equal((await upload('nope', fixture('stock-ru.docx'))).status, 403);

  // Append a Word file: 6 + 11 items, both files listed.
  let res = await upload(body.manageKey, fixture('stock-ru.docx'));
  assert.equal(res.status, 201);
  let out = await res.json();
  assert.equal(out.added, 11);
  assert.equal(out.card.itemCount, 17);
  assert.deepEqual(out.card.files.map(f => [f.name, f.items]), [['stock-en.csv', 6], ['stock-ru.docx', 11]]);
  assert.ok(out.card.files.every(f => f.path === undefined), 'storage paths are never exposed');
  let card = await (await fetch(`${base}/${id}`)).json();
  assert.equal(card.items.length, 17);
  assert.equal(card.items[6].title, 'Лист алюминиевый'); // appended after the existing rows
  assert.equal(card.card.categories.chipboard, 1);

  // Each file downloads by index; default is the latest.
  const f0 = await fetch(`${base}/${id}/file?n=0`);
  assert.match(f0.headers.get('content-disposition'), /stock-en\.csv/);
  const latest = await fetch(`${base}/${id}/file`);
  assert.match(latest.headers.get('content-disposition'), /stock-ru\.docx/);
  assert.equal((await fetch(`${base}/${id}/file?n=5`)).status, 404);

  // A bad file is rejected and changes nothing.
  res = await upload(body.manageKey, { name: 'notes.txt', data: Buffer.from('hello') });
  assert.equal(res.status, 422);
  assert.equal((await (await fetch(`${base}/${id}`)).json()).items.length, 17);

  // Replace: only the new file's items and the new file remain.
  res = await upload(body.manageKey, fixture('stock-ru.pdf'), 'replace');
  out = await res.json();
  assert.equal(res.status, 201);
  assert.equal(out.replaced, true);
  assert.equal(out.card.itemCount, 11);
  assert.deepEqual(out.card.files.map(f => f.name), ['stock-ru.pdf']);
  card = await (await fetch(`${base}/${id}`)).json();
  assert.equal(card.items.length, 11);
  assert.ok(!card.items.some(i => i.title === 'Aluminum sheet'));
  assert.equal((await fetch(`${base}/${id}/file?n=1`)).status, 404);
});
