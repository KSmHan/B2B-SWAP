/* Regenerates the sample stock lists used by test/stock-parser.test.js.
   Needs LibreOffice (`soffice`) on PATH for the Word/PDF conversions:
     node test/fixtures/make-fixtures.js
   The generated files are committed, so running the tests does NOT need it. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const XLSX = require('@e965/xlsx');

const dir = __dirname;
const out = (f) => path.join(dir, f);

// Russian stock list with a header row and section rows.
const RU = [
  ['№', 'Наименование', 'Марка', 'Размер', 'Кол-во', 'Ед. изм.', 'Цена, руб'],
  ['Алюминий', '', '', '', '', '', ''],
  ['1', 'Лист алюминиевый', 'АМг3', '2х1200х3000', '150', 'кг', '380'],
  ['2', 'Профиль', 'АД31Т1', '40х40х2', '600', 'м', '210'],
  ['Медь', '', '', '', '', '', ''],
  ['3', 'Труба медная', 'М1', '22х1', '80', 'м', '950'],
  ['4', 'Шина', 'М1Т', '5х40', '45', 'кг', '1100'],
  ['Сталь', '', '', '', '', '', ''],
  ['5', 'Лист г/к', 'Ст3сп', '4х1500х6000', '2,5', 'т', '72000'],
  ['6', 'Арматура', 'А500С', '12', '1,2', 'т', '65000'],
  ['7', 'Лист нержавеющий', 'AISI 304', '1х1250х2500', '30', 'лист', '14500'],
  ['Древесные плиты', '', '', '', '', '', ''],
  ['8', 'МДФ шлифованный', '', '16х2800х2070', '40', 'лист', '2100'],
  ['9', 'Фанера березовая', 'ФК', '10х1525х1525', '120', 'лист', '1350'],
  ['10', 'ЛДСП Egger', 'W1000', '16х2800х2070', '25', 'лист', '3900'],
  ['11', 'OSB-3', '', '12х1250х2500', '60', 'лист', '980'],
  ['Итого', '', '', '', '', '', '1234567'],
];

// English list without an explicit Name header (Description column instead).
const EN = [
  ['Description', 'Grade', 'Quantity', 'Unit', 'Price'],
  ['Aluminum sheet', '6061-T6', '500', 'kg', '$4.10/kg'],
  ['Copper wire rod', 'C11000', '800', 'kg', '$9.50/kg'],
  ['Hot-rolled steel plate', 'A36', '5', 't', '$780/t'],
  ['Birch plywood 18mm', 'BB/CP', '200', 'sheets', '$38'],
  ['MDF board 18 mm', '', '150', 'sheets', '$24'],
  ['Polycarbonate sheet 3mm', '', '90', 'sheets', '$31'],
];

function toCsv(rows, d) {
  return rows.map(r => r.map(c => /[";\n,]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(d)).join('\r\n') + '\r\n';
}

// Excel .xlsx: RU on sheet 1, EN on sheet 2; plus a sheet named after a material with no category words in rows.
const wb = XLSX.utils.book_new();
// Realistic column widths so a "print to PDF" of the workbook isn't clipped.
const sheet = (rows, widths) => Object.assign(XLSX.utils.aoa_to_sheet(rows), { '!cols': widths.map(wch => ({ wch })) });
XLSX.utils.book_append_sheet(wb, sheet(RU, [3, 20, 8, 12, 6, 6, 9]), 'Остатки');
XLSX.utils.book_append_sheet(wb, sheet(EN, [26, 10, 10, 8, 10]), 'Export');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['Наименование', 'Толщина', 'Кол-во'], ['Лист 1500х3000', '1,5 мм', '12 шт'], ['Круг 60', '', '300 кг'],
]), 'Алюминий');
XLSX.writeFile(wb, out('stock-ru.xlsx'));
// Legacy Excel 97-2003
XLSX.writeFile(wb, out('stock-ru.xls'), { bookType: 'biff8' });

fs.writeFileSync(out('stock-ru-utf8.csv'), '﻿' + toCsv(RU, ';'));
// Windows-1251 CSV via iconv (Node has no 1251 encoder built in).
execFileSync('iconv', ['-f', 'UTF-8', '-t', 'WINDOWS-1251', '-o', out('stock-ru-cp1251.csv')], { input: toCsv(RU, ';') });
fs.writeFileSync(out('stock-en.csv'), toCsv(EN, ','));

// Word .docx built with the `docx` library (a heading, contact paragraph, the table, a footer note),
// then .doc / .pdf converted from it with LibreOffice.
async function main() {
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fx-'));
const D = require('docx');
const para = (text, bold) => new D.Paragraph({ children: [new D.TextRun({ text, bold: !!bold })] });
const table = new D.Table({ width: { size: 100, type: D.WidthType.PERCENTAGE }, rows: RU.map(r => new D.TableRow({ children: r.map(c => new D.TableCell({ children: [para(c)] })) })) });
const docx = new D.Document({ sections: [{ children: [
  para('ООО «Металл-Древ» — складские остатки', true),
  para('Контактное лицо: Иван Петров, тел. +7 900 000-00-00, e-mail: sales@example.com'),
  table,
  para('Цены с НДС. Самовывоз со склада.'),
] }] });
fs.writeFileSync(out('stock-ru.docx'), await D.Packer.toBuffer(docx));
execFileSync('soffice', ['--headless', '--convert-to', 'doc:MS Word 97', '--outdir', tmp, out('stock-ru.docx')], { stdio: 'ignore' });
fs.copyFileSync(path.join(tmp, 'stock-ru.doc'), out('stock-ru.doc'));
execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', tmp, out('stock-ru.docx')], { stdio: 'ignore' });
fs.copyFileSync(path.join(tmp, 'stock-ru.pdf'), out('stock-ru.pdf'));
// A PDF made from the spreadsheet (typical "print to PDF" of an Excel price list).
execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', tmp, out('stock-ru.xlsx')], { stdio: 'ignore' });
fs.copyFileSync(path.join(tmp, 'stock-ru.pdf'), out('stock-ru-from-excel.pdf'));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('fixtures written to', dir);
}
main();
