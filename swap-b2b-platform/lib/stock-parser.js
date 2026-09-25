/* =====================================================================
   B2B SWAP — stock-list file parser.

   Turns ONE uploaded file (Excel .xlsx/.xls/.ods, CSV/TXT, Word
   .docx/.doc, or PDF) into a flat list of catalogue items, each tagged
   with a material type by lib/materials.js.

   Pipeline:  file bytes → tables (rows of text cells) → items
     1. extractTables()  — format-specific: spreadsheet sheets, CSV,
        Word tables + paragraphs, PDF text lines (cells split on tabs).
     2. tablesToItems()  — finds a header row (Name / Qty / Unit / Price
        / Grade / Size …, in English or Russian) and maps columns; without
        a header it falls back to free-text heuristics. Section rows such
        as "Aluminum" / "Фанера" carry their material down to the rows
        beneath them when those rows don't name a material themselves.
   ===================================================================== */
'use strict';

const path = require('path');
const XLSX = require('@e965/xlsx');
const mammoth = require('mammoth');
const WordExtractor = require('word-extractor');
const { classify } = require('./materials');

const MAX_ITEMS = 5000;
const MAX_CELL = 300;

const FORMATS = {
  xlsx: 'excel', xlsm: 'excel', xls: 'excel', ods: 'excel',
  csv: 'csv', tsv: 'csv', txt: 'csv',
  docx: 'docx', doc: 'doc', rtf: 'rtf',
  pdf: 'pdf',
};
const ACCEPTED_EXTENSIONS = Object.keys(FORMATS);

class ParseError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ---------------- format detection ---------------- */
function detectFormat(filename, buf) {
  const ext = path.extname(filename || '').slice(1).toLowerCase();
  const head = buf.subarray(0, 8);
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  const isOle = head.toString('hex').startsWith('d0cf11e0a1b11ae1');
  const isPdf = buf.subarray(0, 1024).toString('latin1').includes('%PDF-');

  if (isPdf) return 'pdf';
  if (isOle) return ext === 'doc' ? 'doc' : 'excel';          // legacy .doc / .xls share a container
  if (isZip) {
    if (ext === 'docx') return 'docx';
    if (['xlsx', 'xlsm', 'ods'].includes(ext)) return 'excel';
    // Unknown zip: peek for the Word main part name.
    return buf.includes(Buffer.from('word/document.xml')) ? 'docx' : 'excel';
  }
  if (buf.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
  if (FORMATS[ext] === 'csv') return 'csv';
  if (FORMATS[ext]) {
    // Extension claims a binary format but the bytes don't match it.
    throw new ParseError('corrupt_file', `This doesn't look like a valid .${ext} file.`);
  }
  throw new ParseError('unsupported_type', 'Unsupported file type. Upload Excel, CSV, Word or PDF.');
}

/* ---------------- text helpers ---------------- */
function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    // Excel on Russian-locale Windows saves CSV as Windows-1251.
    return new TextDecoder('windows-1251').decode(buf);
  }
}

function clean(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CELL);
}

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&'; if (k === 'lt') return '<'; if (k === 'gt') return '>';
    if (k === 'quot') return '"'; if (k === 'apos') return "'"; if (k === 'nbsp') return ' ';
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}
function stripTags(html) {
  return clean(decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')));
}

/** Splits one free-text line into cells: tabs, pipes/semicolons, or runs of 2+ spaces. */
function splitLine(line) {
  let parts;
  if (line.includes('\t')) parts = line.split('\t');
  else if (/\s\|\s|^\||\|$/.test(line)) parts = line.split('|');
  else if ((line.match(/;/g) || []).length >= 2) parts = line.split(';');
  else parts = line.split(/ {2,}/);
  return parts.map(clean);
}

function linesToTable(text, name) {
  const rows = String(text).split(/\r?\n/).map(splitLine).filter(r => r.some(Boolean));
  return { name: name || '', rows, freeText: true };
}

/* ---------------- CSV ---------------- */
function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 20);
  let best = ',', bestScore = 0;
  for (const d of [';', ',', '\t', '|']) {
    const counts = sample.map(l => l.split(d).length - 1).filter(c => c > 0);
    // Prefer a delimiter that appears consistently across lines.
    const score = counts.length ? counts.length * 10 + Math.min(...counts) : 0;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}
function parseCsv(text) {
  const m = text.match(/^sep=(.)\r?\n/i);
  if (m) text = text.slice(m[0].length);
  const d = m ? m[1] : detectDelimiter(text);
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') inQ = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(clean)).filter(r => r.some(Boolean));
}

/* ---------------- per-format extraction ---------------- */
function extractExcel(buf) {
  let wb;
  try {
    wb = XLSX.read(buf, { type: 'buffer', cellDates: true, dense: true, sheetRows: MAX_ITEMS + 200 });
  } catch (e) {
    throw new ParseError('corrupt_file', 'Could not read this spreadsheet — is it password-protected or damaged?');
  }
  return wb.SheetNames.map(name => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false });
    return { name, rows: rows.map(r => r.map(clean)).filter(r => r.some(Boolean)) };
  });
}

async function extractDocx(buf) {
  let html;
  try {
    ({ value: html } = await mammoth.convertToHtml({ buffer: buf }));
  } catch (e) {
    throw new ParseError('corrupt_file', 'Could not read this Word document — is it damaged?');
  }
  const tables = [];
  const withoutTables = html.replace(/<table[\s\S]*?<\/table>/gi, (t) => {
    const rows = [];
    for (const tr of t.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripTags);
      if (cells.some(Boolean)) rows.push(cells);
    }
    if (rows.length) tables.push({ name: '', rows });
    return '\n';
  });
  const paragraphs = (withoutTables.match(/<(p|h\d|li)[^>]*>[\s\S]*?<\/\1>/gi) || []).map(p => decodeEntities(p.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')));
  const text = paragraphs.join('\n').trim();
  if (text) tables.push(linesToTable(text));
  return tables;
}

/* Legacy .doc: word-extractor flattens each Word table onto one line, with a
   tab after every cell AND an extra tab at the end of every row (Word uses the
   same marker for both). Rebuild the rows using the header row's width. */
function splitDocTableLine(line) {
  const fields = line.split('\t');
  if (fields.length < 6) return null;
  let n = 0;
  while (n < fields.length && fields[n].trim()) n++;
  if (n < 2 || fields[n] !== '') return null;
  const width = n + 1;
  const rows = [];
  if (fields.length % width <= 1) {
    for (let i = 0; i + n <= fields.length; i += width) rows.push(fields.slice(i, i + n).map(clean));
  } else {
    // Irregular table (merged cells): fall back to splitting on row-end markers.
    line.split(/\t\t+/).forEach(r => rows.push(r.split('\t').map(clean)));
  }
  return rows.filter(r => r.some(Boolean));
}

async function extractDoc(buf) {
  let body;
  try {
    body = (await new WordExtractor().extract(buf)).getBody();
  } catch (e) {
    throw new ParseError('corrupt_file', 'Could not read this .doc file — try saving it as .docx.');
  }
  const tables = [];
  const loose = [];
  for (const line of body.split(/\r?\n/)) {
    const rows = line.includes('\t\t') ? splitDocTableLine(line) : null;
    if (rows && rows.length > 1) tables.push({ name: '', rows });
    else loose.push(line);
  }
  const text = loose.join('\n').trim();
  if (text) tables.push(linesToTable(text));
  return tables;
}

function extractRtf(buf) {
  // Minimal RTF → text: good enough for simple lists exported from Word.
  const s = buf.toString('latin1')
    .replace(/\\'([0-9a-f]{2})/gi, (m, h) => new TextDecoder('windows-1251').decode(Buffer.from([parseInt(h, 16)])))
    .replace(/\\u(-?\d+)\??/g, (m, n) => String.fromCharCode((+n + 65536) % 65536))
    .replace(/\\(par|line|row)\b ?/g, '\n').replace(/\\cell\b ?/g, '\t')
    .replace(/\{\\\*[^{}]*\}/g, '').replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '');
  return [linesToTable(s)];
}

/* A PDF table cell that wrapped onto several lines: "Наименован\nие",
   "Лист\nалюминиев\nый", "2х1200х300\n0". Re-join word fragments without a
   space (a short lowercase tail, or digits split mid-number), otherwise with one. */
function joinWrappedCell(text) {
  const parts = String(text || '').split(/\r?\n/).map(p => p.trim()).filter(Boolean);
  if (!parts.length) return '';
  let out = parts[0];
  for (const next of parts.slice(1)) {
    const firstWord = next.split(/\s/)[0];
    const glue = (/\d$/.test(out) && /^\d/.test(next)) ||
      (/[a-zа-яё]$/i.test(out) && /^[a-zа-яё]{1,3}$/.test(firstWord) && /[a-zа-яё]{4,}$/i.test(out));
    out += (glue ? '' : ' ') + next;
  }
  return clean(out);
}

async function extractPdf(buf) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf), verbosity: 0 });
  try {
    // 1) Ruled tables (the usual Word/1C/ERP export): real row/column structure.
    const ruled = [];
    try {
      const res = await parser.getTable();
      for (const page of res.pages || []) {
        for (const t of page.tables || []) {
          const rows = t.map(r => r.map(joinWrappedCell)).filter(r => r.some(Boolean));
          if (rows.length >= 2) ruled.push({ name: '', rows, inheritHeader: true });
        }
      }
    } catch (e) { /* no ruled tables — fall through to text */ }

    // 2) Plain text lines, used when there are no ruled tables (or they yield nothing).
    const result = await parser.getText({ cellSeparator: '\t', pageJoiner: '' });
    const text = result.text || '';
    if (!ruled.length && !text.replace(/\s/g, '')) {
      throw new ParseError('pdf_no_text', 'This PDF has no text layer (it looks like a scan). Upload the original Excel/Word file instead.');
    }
    const textTable = linesToTable(text);
    return ruled.length ? Object.assign(ruled, { fallback: [textTable] }) : [textTable];
  } catch (e) {
    if (e instanceof ParseError) throw e;
    if (/password/i.test(e.message || e.name || '')) throw new ParseError('corrupt_file', 'This PDF is password-protected.');
    throw new ParseError('corrupt_file', 'Could not read this PDF — is it damaged?');
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractTables(buf, format) {
  switch (format) {
    case 'excel': return extractExcel(buf);
    case 'csv': return [{ name: '', rows: parseCsv(decodeText(buf)) }];
    case 'docx': return extractDocx(buf);
    case 'doc': return extractDoc(buf);
    case 'rtf': return extractRtf(buf);
    case 'pdf': return extractPdf(buf);
    default: throw new ParseError('unsupported_type', 'Unsupported file type.');
  }
}

/* ---------------- rows → items ---------------- */
const HEADER_ROLES = [
  ['index', /^(№|#|no\.?|n|п\/п|№\s*п\/п|пп|item\s*no\.?|pos\.?|поз\.?)$/i],
  ['category', /^(категория|вид|группа|тип|раздел|category|type|group|material\s*type)/i],
  ['name', /(наименован|название|номенклатур|товар|продукц|позиция|описание|материал|^name$|item|product|description|material)/i],
  ['grade', /(марк|сплав|гост|ту$|стандарт|grade|alloy|standard|spec)/i],
  ['size', /(размер|толщин|сечен|диаметр|формат|длина|ширина|габарит|size|dimension|thickness|diameter|gauge|length|width)/i],
  ['qty', /(кол-?\s*во|количеств|остат|наличи|объ[её]м|вес|масса|тонн|qty|quantity|amount|stock|weight|volume|available)/i],
  ['unit', /^(ед\.?|ед\.?\s*изм\.?|единиц|unit|uom|units)/i],
  ['price', /(цена|стоимост|сумма|price|cost|value|rate)/i],
  ['location', /(склад|город|место|регион|адрес|location|warehouse|city|region)/i],
  ['condition', /(состояни|condition|state)/i],
  ['note', /(примечан|комментар|note|comment|remark)/i],
];

function headerRole(cell) {
  const c = cell.trim();
  if (!c || c.length > 60) return null;
  for (const [role, re] of HEADER_ROLES) if (re.test(c)) return role;
  return null;
}

function findHeader(rows) {
  const limit = Math.min(rows.length, 15);
  for (let i = 0; i < limit; i++) {
    const roles = rows[i].map(headerRole);
    const distinct = new Set(roles.filter(Boolean));
    const hasNumbers = rows[i].some(c => /^\d+([.,]\d+)?$/.test(c));
    if (distinct.size >= 2 && !hasNumbers && (distinct.has('name') || distinct.has('qty') || distinct.has('grade'))) {
      const map = {};
      roles.forEach((r, idx) => { if (r && map[r] === undefined) map[r] = idx; });
      // A spreadsheet with no explicit "name" column: use the first unmapped text column.
      if (map.name === undefined) {
        const free = rows[i].findIndex((c, idx) => !roles[idx] && c);
        map.name = free >= 0 ? free : (map.category !== undefined ? map.category : 0);
      }
      return { index: i, map, headers: rows[i] };
    }
  }
  return null;
}

const UNIT_RE = '(кг|т|тн|тонн[аы]?|шт\\.?|штук|м2|м²|кв\\.?\\s?м|м3|м³|куб\\.?\\s?м|п\\.?\\s?м|м\\.?\\s?п\\.?|пог\\.?\\s?м|м|листов|листа|лист|л|kg|kgs|t|mt|tons?|tonnes?|lbs?|pcs|pieces|units?|sheets?|rolls?|pallets?|m2|m3|sq\\.?\\s?ft|ft|m|meters?|metres?|l)';
const QTY_RE = new RegExp(`(?<![\\da-zа-яё.,×*/-])((?:\\d{1,3}(?:[ \\u00a0]\\d{3})+|\\d+)(?:[.,]\\d+)?)\\s*${UNIT_RE}(?=[^a-zа-я²³0-9]|$)`, 'gi');
const PRICE_RE = /(?:[$€£₽]\s*\d[\d\s,]*(?:\.\d+)?|\d[\d\s]*(?:[.,]\d+)?\s*(?:руб\.?|р\.|₽|usd|eur|\$|€))(?:\s*\/\s*[a-zа-я.²³0-9]+)?/i;

function extractQty(text) {
  let last = null, m;
  QTY_RE.lastIndex = 0;
  while ((m = QTY_RE.exec(text))) last = m;
  return last ? { qty: clean(last[1]), unit: last[2], index: last.index } : null;
}

const NOISE_RE = /(@|https?:\/\/|www\.|тел[.:]|phone|e-?mail|fax|факс|инн|кпп|огрн|р\/с|банк|страница|page\s+\d|^-- \d+ of \d+ --$)/i;
const TOTAL_RE = /^(итого|всего|total|subtotal|grand total|сумма)/i;

function isNumericish(c) { return /^[\d\s.,%$€₽-]+$/.test(c); }

function tableToItems(table, ctx) {
  const items = [];
  const rows = table.rows;
  let header = table.freeText ? null : findHeader(rows);
  // A PDF table continued on the next page has no header row of its own.
  if (!header && table.inheritHeader && ctx.lastHeader && rows[0] && rows[0].length === ctx.lastHeader.headers.length) {
    header = Object.assign({}, ctx.lastHeader, { index: -1 });
  }
  if (header) ctx.lastHeader = header;
  // A sheet named "Aluminum" / "Фанера" sets the default material for its rows.
  let section = classify(table.name) || null;
  const start = header ? header.index + 1 : 0;

  for (let i = start; i < rows.length && ctx.count < MAX_ITEMS; i++) {
    const row = rows[i];
    const cells = row.filter(Boolean);
    if (!cells.length) continue;
    let joined = cells.join(' ');
    if (TOTAL_RE.test(cells[0])) continue;

    // Section heading: one short text cell with no digits, e.g. "Алюминиевый прокат".
    if (cells.length === 1 && !/\d/.test(joined) && joined.length <= 60) {
      if (header && headerRole(joined)) continue;
      section = classify(joined) || (header ? section : null);
      continue;
    }
    // A repeated header row (common in multi-page PDFs / exports).
    if (row.map(headerRole).filter(Boolean).length >= 2 && !row.some(c => /\d/.test(c))) continue;

    let item;
    if (header) {
      const m = header.map;
      const get = (role) => (m[role] !== undefined ? clean(row[m[role]]) : '');
      let title = get('name');
      const specs = [];
      row.forEach((c, idx) => {
        if (!c) return;
        const role = Object.keys(m).find(r => m[r] === idx);
        if (['name', 'index', 'qty', 'unit', 'price'].includes(role)) return;
        const h = clean(header.headers[idx]);
        specs.push(h ? `${h}: ${c}` : c);
      });
      if (!title || isNumericish(title)) {
        title = row.filter((c, idx) => c && !isNumericish(c) && idx !== m.index).slice(0, 2).join(' ');
      }
      if (!title) continue;
      let qty = get('qty'), unit = get('unit');
      if (qty && !unit) {
        const q = extractQty(qty);
        if (q) { qty = q.qty; unit = q.unit; }
      }
      if (!qty) {
        const q = extractQty(title);
        if (q) { qty = q.qty; unit = q.unit; }
      }
      item = {
        title, qty, unit,
        price: get('price'),
        specs: specs.join(' · '),
        classifyText: [get('category'), title, get('grade'), get('size'), get('note')].join(' '),
      };
    } else {
      if (NOISE_RE.test(joined)) continue;
      // Drop a leading row number ("7 Лист …" / "7." / a lone "7" cell) before reading quantities.
      if (/^\d{1,4}[.)]?$/.test(cells[0]) && cells.length > 1) cells.shift();
      else cells[0] = cells[0].replace(/^\d{1,4}[.)]?\s+(?=[^\d\s])/, '');
      joined = cells.join(' ');
      const textCells = cells.filter(c => !isNumericish(c));
      if (!textCells.length) continue;
      const q = extractQty(joined);
      const priceMatch = joined.match(PRICE_RE);
      const own = classify(joined);
      // Free text (PDF/Word prose): only keep lines that look like stock —
      // they name a material, or give a quantity under a material section.
      if (!own && !(q && section)) continue;
      let title = textCells[0];
      if (cells.length === 1 && q && q.index > 0) {
        // A whole line of prose-like text ("Aluminum 6061-T6 500 kg $4.10/kg"):
        // the title is what comes before the quantity.
        title = joined.slice(0, q.index);
      }
      title = clean(title.replace(/^\d{1,4}[.)]?\s+(?=[^\d\s])/, ''));
      if (!title) continue;
      item = {
        title,
        qty: q ? q.qty : '',
        unit: q ? q.unit : '',
        price: priceMatch ? clean(priceMatch[0]) : '',
        specs: cells.length > 1 ? cells.filter(c => c !== textCells[0] && !/^\d{1,4}$/.test(c)).join(' · ') : '',
        classifyText: joined,
      };
    }

    const own = classify(item.classifyText);
    const category = own || section || 'other';
    items.push({
      category,
      title: item.title.slice(0, 200),
      qty: clean(item.qty).slice(0, 40),
      unit: clean(item.unit).slice(0, 20),
      price: clean(item.price).slice(0, 60),
      specs: clean(item.specs).slice(0, MAX_CELL),
    });
    ctx.count++;
  }
  return items;
}

function tablesToItems(tables) {
  const ctx = { count: 0 };
  const items = [];
  for (const t of tables) items.push(...tableToItems(t, ctx));
  return { items, truncated: ctx.count >= MAX_ITEMS };
}

/** Parses an uploaded file into { format, items, truncated }. Throws ParseError. */
async function parseStockFile(buf, filename) {
  if (!buf || !buf.length) throw new ParseError('empty_file', 'The file is empty.');
  const format = detectFormat(filename, buf);
  const tables = await extractTables(buf, format);
  let { items, truncated } = tablesToItems(tables);
  if (!items.length && tables.fallback) ({ items, truncated } = tablesToItems(tables.fallback));
  if (!items.length) {
    throw new ParseError('no_items', "We couldn't find any stock items in this file. A simple table with a Name column (plus Qty/Unit/Price if you have them) works best.");
  }
  return { format, items, truncated };
}

module.exports = { parseStockFile, detectFormat, extractTables, tablesToItems, parseCsv, ParseError, ACCEPTED_EXTENSIONS, MAX_ITEMS };
