'use strict';
// Upload formats: every sample stock list must yield the same, correctly
// catalogued items. Fixtures are produced by test/fixtures/make-fixtures.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseStockFile, parseCsv, detectFormat, ParseError } = require('../lib/stock-parser');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f));

// The Russian sample list (sheet 1 / the Word table / the CSVs).
const RU_EXPECTED = [
  ['aluminum', 'Лист алюминиевый', '150', 'кг'],
  ['aluminum', 'Профиль', '600', 'м'],
  ['copper', 'Труба медная', '80', 'м'],
  ['copper', 'Шина', '45', 'кг'],
  ['steel', 'Лист г/к', '2,5', 'т'],
  ['steel', 'Арматура', '1,2', 'т'],
  ['stainless', 'Лист нержавеющий', '30', 'лист'],
  ['mdf', 'МДФ шлифованный', '40', 'лист'],
  ['plywood', 'Фанера березовая', '120', 'лист'],
  ['chipboard', 'ЛДСП Egger', '25', 'лист'],
  ['osb', 'OSB-3', '60', 'лист'],
];
const EN_EXPECTED = [
  ['aluminum', 'Aluminum sheet'], ['copper', 'Copper wire rod'], ['steel', 'Hot-rolled steel plate'],
  ['plywood', 'Birch plywood 18mm'], ['mdf', 'MDF board 18 mm'], ['plastic', 'Polycarbonate sheet 3mm'],
];

function assertRu(items) {
  assert.deepEqual(items.slice(0, 11).map(i => [i.category, i.title, i.qty, i.unit]), RU_EXPECTED);
  assert.equal(items[0].price, '380');
  assert.match(items[0].specs, /АМг3/);
}

for (const [file, format] of [['stock-ru.xlsx', 'excel'], ['stock-ru.xls', 'excel']]) {
  test(`Excel ${file}: all sheets, header mapping, sheet name as material`, async () => {
    const r = await parseStockFile(fx(file), file);
    assert.equal(r.format, format);
    assert.equal(r.items.length, 19);
    assertRu(r.items);
    assert.deepEqual(r.items.slice(11, 17).map(i => [i.category, i.title]), EN_EXPECTED);
    assert.equal(r.items[11].price, '$4.10/kg');
    // Sheet "Алюминий": rows never say "aluminum" themselves.
    assert.deepEqual(r.items.slice(17).map(i => [i.category, i.title, i.qty, i.unit]),
      [['aluminum', 'Лист 1500х3000', '12', 'шт'], ['aluminum', 'Круг 60', '300', 'кг']]);
  });
}

for (const file of ['stock-ru-utf8.csv', 'stock-ru-cp1251.csv']) {
  test(`CSV ${file}: encoding + ";" delimiter, totals row skipped`, async () => {
    const r = await parseStockFile(fx(file), file);
    assert.equal(r.format, 'csv');
    assert.equal(r.items.length, 11);
    assertRu(r.items);
  });
}

test('CSV stock-en.csv: English headers, comma delimiter', async () => {
  const r = await parseStockFile(fx('stock-en.csv'), 'stock-en.csv');
  assert.deepEqual(r.items.map(i => [i.category, i.title]), EN_EXPECTED);
  assert.deepEqual([r.items[2].qty, r.items[2].unit, r.items[2].price], ['5', 't', '$780/t']);
});

for (const [file, format] of [['stock-ru.docx', 'docx'], ['stock-ru.doc', 'doc']]) {
  test(`Word ${file}: table extracted, contact paragraphs ignored`, async () => {
    const r = await parseStockFile(fx(file), file);
    assert.equal(r.format, format);
    assert.equal(r.items.length, 11);
    assertRu(r.items);
  });
}

test('PDF with a ruled table (Word → PDF): wrapped cells re-joined', async () => {
  const r = await parseStockFile(fx('stock-ru.pdf'), 'stock-ru.pdf');
  assert.equal(r.format, 'pdf');
  assert.equal(r.items.length, 11);
  assertRu(r.items);
});

test('PDF without table lines (Excel "print to PDF"): text lines', async () => {
  const r = await parseStockFile(fx('stock-ru-from-excel.pdf'), 'stock-ru-from-excel.pdf');
  assert.equal(r.format, 'pdf');
  const got = r.items.map(i => [i.category, i.qty, i.unit]);
  assert.deepEqual(got.slice(0, 11), RU_EXPECTED.map(([c, , q, u]) => [c, q, u]));
  assert.equal(r.items[0].title, 'Лист алюминиевый АМг3 2х1200х3000');
  assert.deepEqual(r.items.slice(11).map(i => i.category), EN_EXPECTED.map(e => e[0]));
});

test('format is detected from content, not just the extension', () => {
  assert.equal(detectFormat('list.bin', fx('stock-ru.pdf')), 'pdf');
  assert.equal(detectFormat('list.XLSX', fx('stock-ru.xlsx')), 'excel');
  assert.equal(detectFormat('list.doc', fx('stock-ru.doc')), 'doc');
  assert.throws(() => detectFormat('fake.xlsx', Buffer.from('hello world')), (e) => e instanceof ParseError && e.code === 'corrupt_file');
  assert.throws(() => detectFormat('virus.exe', Buffer.from('MZ....')), (e) => e.code === 'unsupported_type');
});

test('empty file and a file with no stock items are rejected clearly', async () => {
  await assert.rejects(parseStockFile(Buffer.alloc(0), 'a.csv'), (e) => e.code === 'empty_file');
  await assert.rejects(parseStockFile(Buffer.from('hello\nworld\n'), 'a.txt'), (e) => e.code === 'no_items');
});

test('CSV parser handles quotes, embedded delimiters and newlines', () => {
  const rows = parseCsv('Name,Qty\n"Sheet, 2mm ""A""",5\n"Multi\nline",3\n');
  assert.deepEqual(rows, [['Name', 'Qty'], ['Sheet, 2mm "A"', '5'], ['Multi line', '3']]);
});

test('headerless free text keeps only stock lines', async () => {
  const txt = 'Dear partner, here is our surplus.\nContact: sales@example.com\n' +
    'Aluminum sheet 5083 H111 3mm   1 200 kg   $3.90/kg\nCopper busbar 5x40   45 kg\nThank you!\n';
  const r = await parseStockFile(Buffer.from(txt), 'offer.txt');
  assert.deepEqual(r.items.map(i => [i.category, i.title, i.qty, i.unit, i.price]), [
    ['aluminum', 'Aluminum sheet 5083 H111 3mm', '1 200', 'kg', '$3.90/kg'],
    ['copper', 'Copper busbar 5x40', '45', 'kg', ''],
  ]);
});
