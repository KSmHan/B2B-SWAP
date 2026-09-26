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
  // Stand-in for auth-mw's attachAccount: "X-Test-Email" = a logged-in, verified account.
  app.use((req, res, next) => {
    const email = req.get('X-Test-Email');
    req.account = email ? { id: 'acc-' + email, email, verified: true, company: 'Acme' } : null;
    next();
  });
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

  const owner = { headers: { 'X-Test-Email': 'ivan@example.com' } };
  const mdf = await (await fetch(`${base}/items?cat=mdf`, owner)).json();
  assert.ok(mdf.items.length >= 1 && mdf.items.every(i => i.category === 'mdf'));
  assert.ok(mdf.items[0].card.company && mdf.items[0].card.phone);

  const search = await (await fetch(`${base}/items?q=${encodeURIComponent('birch plywood')}`, owner)).json();
  // Earlier Excel uploads in this store also carry "Birch plywood 18mm".
  assert.ok(search.total >= 1);
  assert.ok(search.items.every(i => /birch plywood/i.test(i.title)));
  assert.ok(search.items.some(i => i.card.id === id));

  const mats = await (await fetch(`${base}/materials`, owner)).json();
  assert.ok(mats.materials.find(m => m.key === 'aluminum').count >= 9);

  const file = await fetch(`${base}/${id}/file`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /stock-en\.csv/);
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), fixture('stock-en.csv').data.toString());

  const list = await (await fetch(base, owner)).json();
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

test('"My materials" is private: only the logged-in owner sees their own items', async () => {
  const { body } = await post(Object.assign({}, CONTACT, { email: 'solo@private.example', company: 'Solo Metals' }), fixture('stock-en.csv'));
  const as = (email) => ({ headers: email ? { 'X-Test-Email': email } : {} });

  for (const path of ['/items', '/materials', '']) {
    assert.equal((await fetch(`${base}${path}`)).status, 401, `anonymous ${path || '/'}`);
  }
  const mine = await (await fetch(`${base}/items`, as('solo@private.example'))).json();
  assert.equal(mine.total, 6);
  assert.ok(mine.items.every(i => i.card.id === body.card.id));
  const counts = (await (await fetch(`${base}/materials`, as('solo@private.example'))).json()).materials;
  assert.equal(counts.reduce((n, m) => n + m.count, 0), 6);
  const cards = (await (await fetch(base, as('solo@private.example'))).json()).cards;
  assert.deepEqual(cards.map(c => c.id), [body.card.id]);

  const other = await (await fetch(`${base}/items`, as('someone@else.example'))).json();
  assert.equal(other.total, 0);
  assert.equal((await (await fetch(`${base}/material-types`)).json()).materials.length > 10, true);
});

test('owner logged in with the card email can manage it without the manage link', async () => {
  const { body } = await post(Object.assign({}, CONTACT, { email: 'boss@owner.example' }), fixture('stock-en.csv'));
  const id = body.card.id;
  const card = await (await fetch(`${base}/${id}`, { headers: { 'X-Test-Email': 'boss@owner.example' } })).json();
  assert.equal(card.card.isOwner, true);
  assert.equal((await (await fetch(`${base}/${id}`)).json()).card.isOwner, false);

  const item = card.items[0];
  const patch = (email) => fetch(`${base}/${id}/items/${item.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Test-Email': email }, body: JSON.stringify({ category: 'copper' }),
  });
  assert.equal((await patch('intruder@example.com')).status, 403);
  assert.equal((await patch('boss@owner.example')).status, 200);
  assert.equal((await fetch(`${base}/${id}`, { method: 'DELETE', headers: { 'X-Test-Email': 'boss@owner.example' } })).status, 200);
});

test('a logged-in upload is tied to the account email, whatever the form says', async () => {
  const fd = form(Object.assign({}, CONTACT, { email: 'typed@elsewhere.example' }), fixture('stock-en.csv'));
  const res = await fetch(base, { method: 'POST', body: fd, headers: { 'X-Test-Email': 'acct@owner.example' } });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.card.email, 'acct@owner.example');
});

test('"What do you need in return?" is saved on upload and editable by the owner only', async () => {
  const { status, body } = await post(Object.assign({}, CONTACT, { email: 'wants@owner.example', wants: '  plywood, packaging  ' }), fixture('stock-en.csv'));
  assert.equal(status, 201);
  assert.equal(body.card.wants, 'plywood, packaging');
  const id = body.card.id;
  const patch = (headers, wants) => fetch(`${base}/${id}`, { method: 'PATCH', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify({ wants }) });

  assert.equal((await patch({ 'X-Test-Email': 'other@x.example' }, 'steel')).status, 403);
  let r = await patch({ 'X-Manage-Key': body.manageKey }, 'steel or copper');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).card.wants, 'steel or copper');
  r = await patch({ 'X-Test-Email': 'wants@owner.example' }, '');
  assert.equal((await r.json()).card.wants, '');
  assert.equal((await (await fetch(`${base}/${id}`)).json()).card.wants, '');
});

test('owner can delete one item, and all of their lists at once', async () => {
  const owner = { 'X-Test-Email': 'del@owner.example' };
  const a = (await post(Object.assign({}, CONTACT, { email: 'del@owner.example' }), fixture('stock-en.csv'))).body.card.id;
  const b = (await post(Object.assign({}, CONTACT, { email: 'del@owner.example' }), fixture('stock-ru.xlsx'))).body.card.id;
  const keep = (await post(Object.assign({}, CONTACT, { email: 'keep@other.example' }), fixture('stock-en.csv'))).body.card.id;

  const card = await (await fetch(`${base}/${a}`, { headers: owner })).json();
  const before = card.items.length;
  const del = (id, email) => fetch(`${base}/${a}/items/${id}`, { method: 'DELETE', headers: { 'X-Test-Email': email } });
  assert.equal((await del(card.items[0].id, 'intruder@example.com')).status, 403);
  assert.equal((await del(card.items[0].id, 'del@owner.example')).status, 200);
  assert.equal((await del(card.items[0].id, 'del@owner.example')).status, 404); // already gone
  const after = await (await fetch(`${base}/${a}`, { headers: owner })).json();
  assert.equal(after.items.length, before - 1);
  assert.equal(after.card.itemCount, before - 1);

  assert.equal((await fetch(base, { method: 'DELETE' })).status, 401);
  const all = await (await fetch(base, { method: 'DELETE', headers: owner })).json();
  assert.equal(all.deleted, 2);
  assert.equal((await fetch(`${base}/${a}`)).status, 404);
  assert.equal((await fetch(`${base}/${b}`)).status, 404);
  assert.equal((await fetch(`${base}/${keep}`)).status, 200); // someone else's list is untouched
});
