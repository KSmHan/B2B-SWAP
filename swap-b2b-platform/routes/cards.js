/* =====================================================================
   B2B SWAP — stock cards: publish a company's whole stock list from ONE
   file, with no account needed — just company name + contact person,
   email and phone. Every row is catalogued by material automatically.

   POST   /api/cards                         multipart: company, contactName, email, phone, file, wants?
   GET    /api/cards                         (logged in) the account's own cards
   GET    /api/cards/materials               (logged in) material types with the account's item counts
   GET    /api/cards/items?cat=&q=&offset=   (logged in) the account's own items

   "Own" = cards uploaded with the account's verified email. The public
   catalog and the chain search see every card via /api/listings instead.
   GET    /api/cards/:id                     one card + its items
   GET    /api/cards/:id/file?n=             download uploaded file #n (default: latest)
   POST   /api/cards/:id/files               (X-Manage-Key) multipart: file, mode=append|replace
   PATCH  /api/cards/:id                     (X-Manage-Key or owner login) { wants } — what they need in return
   DELETE /api/cards                         (logged in) remove all of the account's own cards
   DELETE /api/cards/:id                     (X-Manage-Key or owner login) remove the card
   DELETE /api/cards/:id/items/:itemId       (X-Manage-Key or owner login) remove one item
   PATCH  /api/cards/:id/items/:itemId       (X-Manage-Key or owner login) { category } — fix a material
   ===================================================================== */
'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { customAlphabet } = require('nanoid');

const { parseStockFile, ParseError, ACCEPTED_EXTENSIONS, MAX_ITEMS } = require('../lib/stock-parser');
const { listMaterials, isMaterial } = require('../lib/materials');
const { getDefaultStore, publicCard } = require('../lib/cards-store');

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

// Vercel Functions cap the request body at 4.5 MB, so 4 MB is the safe default there.
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 4);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[\d\s()\-.]{6,25}$/;

const CONTENT_TYPES = {
  excel: 'application/vnd.ms-excel', csv: 'text/csv', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword', rtf: 'application/rtf', pdf: 'application/pdf',
};

function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function sanitizeFileName(name) {
  // multer hands over the multipart filename as latin1; browsers send UTF-8.
  let n = String(name || 'stock-list');
  try { n = Buffer.from(n, 'latin1').toString('utf8'); } catch (e) { /* keep as is */ }
  return n.replace(/[\\/\u0000-\u001f"<>|:*?]/g, '_').slice(-120);
}
function field(v, max) { return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max); }

function countCategories(items) {
  const out = {};
  items.forEach(it => { out[it.category] = (out[it.category] || 0) + 1; });
  return out;
}

/** The logged-in account owns a card uploaded with its (verified) email. */
function ownerEmail(req) {
  return req.account && req.account.verified && req.account.email ? String(req.account.email).toLowerCase() : null;
}
function isOwner(req, card) {
  const email = ownerEmail(req);
  return !!(email && card && card.email === email);
}
function requireLogin(req, res, next) {
  if (!ownerEmail(req)) return res.status(401).json({ error: 'not_authenticated', message: 'Log in to see your materials.' });
  next();
}

function createCardsRouter({ store = getDefaultStore(), mailer = require('../mailer'), uploadLimit } = {}) {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 10, fieldSize: 2000 },
  });
  const uploadLimiter = uploadLimit || rateLimit({
    windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
    message: { error: 'too_many_requests', message: 'Too many uploads from this network — please try again in an hour.' },
  });

  function receiveFile(req, res, next) {
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'file_too_large', message: `The file is larger than ${MAX_UPLOAD_MB} MB. Remove images or split the list and try again.` });
      }
      return res.status(400).json({ error: 'bad_upload', message: 'Upload one file in the "file" field.' });
    });
  }

  /** Validates + parses req.file. Sends a 4xx and returns null when it can't be used. */
  async function readStockUpload(req, res) {
    const fileName = sanitizeFileName(req.file.originalname);
    const ext = path.extname(fileName).slice(1).toLowerCase();
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      res.status(400).json({ error: 'unsupported_type', fields: { file: 'Upload an Excel (.xlsx, .xls), CSV, Word (.docx, .doc) or PDF file.' } });
      return null;
    }
    try {
      const parsed = await parseStockFile(req.file.buffer, fileName);
      return { fileName, ext, parsed };
    } catch (e) {
      if (e instanceof ParseError) res.status(422).json({ error: e.code, fields: { file: e.message } });
      else {
        console.error('[cards] parse failed:', e);
        res.status(422).json({ error: 'parse_failed', fields: { file: 'We could not read this file. Try saving it as .xlsx or .csv.' } });
      }
      return null;
    }
  }

  /** Keeps the original upload for download. A storage hiccup must not lose the listing itself. */
  async function storeOriginal(cardId, upload, size, buffer) {
    let filePath = `${cardId}/${Date.now()}.${upload.ext}`;
    try {
      await store.saveFile(filePath, buffer, CONTENT_TYPES[upload.parsed.format] || 'application/octet-stream');
    } catch (e) {
      console.error('[cards] original file not stored:', e.message);
      filePath = null;
    }
    return {
      name: upload.fileName, path: filePath, format: upload.parsed.format, size,
      items: upload.parsed.items.length, uploadedAt: Date.now(),
    };
  }

  async function requireManageKey(req, res) {
    const card = await store.getCard(req.params.id);
    if (!card) { res.status(404).json({ error: 'not_found' }); return null; }
    const key = req.get('X-Manage-Key') || '';
    const admin = process.env.ADMIN_TOKEN;
    const ok = (key && safeEqual(hashToken(key), card.manageTokenHash)) || (admin && admin.length >= 16 && safeEqual(key, admin)) ||
      isOwner(req, card);
    if (!ok) { res.status(403).json({ error: 'forbidden', message: 'This manage link is not valid for this card.' }); return null; }
    return card;
  }

  // POST /api/cards
  router.post('/', uploadLimiter, receiveFile, async (req, res) => {
    const b = req.body || {};
    if (b.website) return res.status(400).json({ error: 'rejected' }); // honeypot — humans never see this field

    const company = field(b.company, 120);
    const contactName = field(b.contactName, 80);
    // Logged in: the card always belongs to the account, so it shows under "My materials".
    const email = ownerEmail(req) || field(b.email, 160).toLowerCase();
    const phone = field(b.phone, 30);
    const wants = field(b.wants, 200); // optional: "What do you need in return?"
    const errors = {};
    if (company.length < 2) errors.company = 'Enter your company name.';
    if (contactName.length < 2) errors.contactName = 'Enter a contact name.';
    if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email.';
    if (!PHONE_RE.test(phone) || phone.replace(/\D/g, '').length < 6) errors.phone = 'Enter a valid phone number.';
    if (!req.file) errors.file = 'Attach your stock list (Excel, CSV, Word or PDF).';
    if (Object.keys(errors).length) return res.status(400).json({ error: 'invalid_fields', fields: errors });

    const upload = await readStockUpload(req, res);
    if (!upload) return;
    const { fileName, parsed } = upload;

    const id = nanoid();
    const manageKey = crypto.randomBytes(24).toString('base64url');
    const file = await storeOriginal(id, upload, req.file.size, req.file.buffer);

    const card = await store.createCard({
      id, company, contactName, email, phone, wants,
      fileName, fileFormat: parsed.format, fileSize: req.file.size, filePath: file.path,
      files: [file], categories: countCategories(parsed.items), manageTokenHash: hashToken(manageKey),
    }, parsed.items);

    const origin = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const cardUrl = `${origin}/card.html?id=${id}`;
    const manageUrl = `${cardUrl}&key=${manageKey}`;
    const mail = await mailer.sendMail({
      to: email,
      subject: `Your stock list is live on B2B SWAP (${parsed.items.length} items)`,
      text: `Hi ${contactName},\n\n${company}'s stock list "${fileName}" is now live on B2B SWAP with ${parsed.items.length} items.\n\n` +
        `Public page: ${cardUrl}\nManage or remove it (keep this link private): ${manageUrl}\n\n— B2B SWAP`,
    }).catch(() => ({ sent: false }));

    res.status(201).json({
      card: publicCard(card),
      items: parsed.items.slice(0, 50),
      truncated: parsed.truncated,
      manageKey,
      cardUrl, manageUrl,
      emailSent: !!mail.sent,
    });
  });

  // GET /api/cards — the logged-in account's own cards
  router.get('/', requireLogin, async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 50);
    const cards = await store.listCards({ limit, email: ownerEmail(req) });
    res.json({ cards: cards.map(publicCard) });
  });

  // GET /api/cards/materials — material types with the account's own item counts
  router.get('/materials', requireLogin, async (req, res) => {
    const counts = await store.categoryCounts({ email: ownerEmail(req) });
    res.json({ materials: listMaterials().map(m => Object.assign(m, { count: counts[m.key] || 0 })) });
  });

  // GET /api/cards/material-types — the list of material types (public; used for labels)
  router.get('/material-types', (req, res) => {
    res.json({ materials: listMaterials() });
  });

  // GET /api/cards/items — the account's own items
  router.get('/items', requireLogin, async (req, res) => {
    const category = isMaterial(req.query.cat) ? req.query.cat : '';
    const q = field(req.query.q, 80);
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const result = await store.listItems({ category, q, limit, offset, email: ownerEmail(req) });
    res.json(result);
  });

  // GET /api/cards/:id
  router.get('/:id', async (req, res) => {
    const card = await store.getCard(req.params.id);
    if (!card || card.status !== 'live') return res.status(404).json({ error: 'not_found' });
    const items = await store.cardItems(card.id);
    res.json({ card: Object.assign(publicCard(card), { hasFile: card.files.some(f => f.path), isOwner: isOwner(req, card) }), items });
  });

  // GET /api/cards/:id/file
  router.get('/:id/file', async (req, res) => {
    const card = await store.getCard(req.params.id);
    if (!card || card.status !== 'live') return res.status(404).json({ error: 'not_found' });
    const n = req.query.n === undefined ? card.files.length - 1 : Number(req.query.n);
    if (!Number.isInteger(n) || n < 0 || n >= card.files.length) return res.status(404).json({ error: 'file_not_available' });
    const f = await store.fileDownload(card, n);
    if (!f) return res.status(404).json({ error: 'file_not_available' });
    if (f.url) return res.redirect(302, f.url);
    res.set('Content-Type', f.contentType || 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(card.files[n].name || 'stock-list')}`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(f.buffer);
  });

  // POST /api/cards/:id/files — the owner adds another stock file to the card.
  // mode=append (default) adds its items; mode=replace swaps the whole list for it.
  router.post('/:id/files', uploadLimiter, async (req, res, next) => {
    const card = await requireManageKey(req, res);
    if (card) { req.card = card; next(); }
  }, receiveFile, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'invalid_fields', fields: { file: 'Attach your stock list (Excel, CSV, Word or PDF).' } });
    const replace = (req.body || {}).mode === 'replace';
    const upload = await readStockUpload(req, res);
    if (!upload) return;
    const items = upload.parsed.items;
    if (!replace && req.card.itemCount + items.length > MAX_ITEMS) {
      return res.status(422).json({ error: 'too_many_items', fields: { file: `A card can hold up to ${MAX_ITEMS} items — this file would bring it to ${req.card.itemCount + items.length}. Use "Replace the list" instead.` } });
    }
    const file = await storeOriginal(req.card.id, upload, req.file.size, req.file.buffer);
    const card = await store.addFile(req.card.id, file, items, { replace });
    res.status(201).json({ card: publicCard(card), added: items.length, replaced: replace, categories: countCategories(items) });
  });

  // PATCH /api/cards/:id { wants } — the owner changes what they need in return
  router.patch('/:id', express.json(), async (req, res) => {
    const card = await requireManageKey(req, res);
    if (!card) return;
    const wants = field((req.body || {}).wants, 200);
    try {
      const updated = await store.updateWants(card.id, wants);
      res.json({ card: publicCard(updated) });
    } catch (e) {
      if (e.code === 'wants_column_missing') return res.status(503).json({ error: 'not_ready', message: 'Saving this needs a database update (supabase/003_stock_card_wants.sql).' });
      throw e;
    }
  });

  // DELETE /api/cards/:id
  // DELETE /api/cards — every stock list of the logged-in owner ("Delete all" on My materials).
  router.delete('/', requireLogin, async (req, res) => {
    const email = ownerEmail(req);
    let deleted = 0;
    for (;;) {
      const cards = await store.listCards({ limit: 50, email });
      if (!cards.length) break;
      let round = 0;
      for (const c of cards) if (await store.deleteCard(c.id)) round++;
      deleted += round;
      if (!round) break; // nothing left we can delete — never spin
    }
    res.json({ ok: true, deleted });
  });

  // DELETE /api/cards/:id/items/:itemId — one item of a list.
  router.delete('/:id/items/:itemId', async (req, res) => {
    const card = await requireManageKey(req, res);
    if (!card) return;
    const ok = await store.deleteItem(card.id, req.params.itemId);
    if (!ok) return res.status(404).json({ error: 'item_not_found' });
    res.json({ ok: true });
  });

  router.delete('/:id', async (req, res) => {
    const card = await requireManageKey(req, res);
    if (!card) return;
    await store.deleteCard(card.id);
    res.json({ ok: true });
  });

  // PATCH /api/cards/:id/items/:itemId { category }
  router.patch('/:id/items/:itemId', express.json(), async (req, res) => {
    const card = await requireManageKey(req, res);
    if (!card) return;
    const category = (req.body || {}).category;
    if (!isMaterial(category)) return res.status(400).json({ error: 'invalid_category' });
    const ok = await store.updateItemCategory(card.id, req.params.itemId, category);
    if (!ok) return res.status(404).json({ error: 'item_not_found' });
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createCardsRouter, MAX_UPLOAD_MB };
